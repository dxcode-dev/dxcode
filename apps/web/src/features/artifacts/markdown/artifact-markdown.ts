/**
 * An artifact's Markdown, to and from the editor's ProseMirror document.
 *
 * Markdown is the stored format, so the codec keeps every byte a person did
 * not touch: parsing records each top-level block's source text and the
 * blank lines after it, and each list item's, and serializing writes a block
 * whose content is unchanged from those bytes. Only a block that changed is
 * written afresh, with the fewest escapes that still parse back to the same
 * content. Text Markdown has no block for (reference definitions) becomes a
 * `markdown_source` block written verbatim, so nothing is ever dropped.
 */
import MarkdownIt from "markdown-it";
import {
  MarkdownSerializer,
  MarkdownSerializerState,
} from "prosemirror-markdown";
import {
  Fragment,
  type Mark,
  type MarkSpec,
  type MarkType,
  type Node,
  type NodeSpec,
  Schema,
} from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";
import { parseChip } from "./chips.js";
import { itemAt } from "./item-at.js";

type Token = ReturnType<MarkdownIt["parse"]>[number];

const keyAttr = { key: { default: null } };

/**
 * Whether a link target is safe to make clickable: web and mail links,
 * dx's mention targets, and relative paths. Not `javascript:`, `data:`, or
 * any other scheme.
 */
export const safeHref = (href: string) => {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return (
    scheme === undefined || ["http", "https", "mailto", "user"].includes(scheme)
  );
};

const tables = tableNodes({
  tableGroup: "block",
  // One paragraph per cell, as the table commands expect: arrows, Tab,
  // and typing then stay inside cells. Markdown writes its inline content.
  cellContent: "paragraph",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => dom.style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (typeof value === "string")
          attrs.style = `${attrs.style ?? ""}text-align: ${value};`;
      },
    },
  },
});

const nodes = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    attrs: keyAttr,
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  heading: {
    attrs: { level: { default: 1 }, markup: { default: "#" }, ...keyAttr },
    content: "(text | image | chip)*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      attrs: { level },
    })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },
  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    attrs: keyAttr,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  horizontal_rule: {
    group: "block",
    attrs: { markup: { default: "---" }, ...keyAttr },
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  code_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    attrs: {
      params: { default: "" },
      markup: { default: "```" },
      ...keyAttr,
    },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: (node) => [
      "pre",
      node.attrs.params ? { "data-language": node.attrs.params } : {},
      ["code", 0],
    ],
  },
  /** Markdown text with no block of its own, such as reference definitions. */
  markdown_source: {
    group: "block",
    atom: true,
    selectable: true,
    attrs: { source: { default: "" }, ...keyAttr },
    toDOM: (node) => [
      "pre",
      { class: "artifact-markdown-source" },
      node.attrs.source,
    ],
  },
  bullet_list: {
    content: "list_item+",
    group: "block",
    attrs: { tight: { default: true }, markup: { default: "-" }, ...keyAttr },
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    content: "list_item+",
    group: "block",
    attrs: {
      order: { default: 1 },
      tight: { default: true },
      markup: { default: "." },
      ...keyAttr,
    },
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) => [
      "ol",
      node.attrs.order === 1 ? {} : { start: node.attrs.order },
      0,
    ],
  },
  list_item: {
    content: "paragraph block*",
    defining: true,
    /** `null` for a plain item; a checklist item's tick otherwise. */
    attrs: { checked: { default: null }, ...keyAttr },
    parseDOM: [{ tag: "li" }],
    toDOM: (node) => [
      "li",
      node.attrs.checked === null
        ? {}
        : { "data-checked": String(node.attrs.checked) },
      0,
    ],
  },
  table: {
    ...tables.table,
    attrs: { ...tables.table.attrs, ...keyAttr },
  },
  table_row: { ...tables.table_row, attrs: keyAttr },
  table_header: tables.table_header,
  table_cell: tables.table_cell,
  text: { group: "inline" },
  image: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: {
      src: { default: "" },
      alt: { default: "" },
      title: { default: null },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => ({
          src: dom.getAttribute("src"),
          alt: dom.getAttribute("alt") ?? "",
          title: dom.getAttribute("title"),
        }),
      },
    ],
    toDOM: (node) => [
      "img",
      {
        src: node.attrs.src,
        alt: node.attrs.alt,
        ...(node.attrs.title === null ? {} : { title: node.attrs.title }),
      },
    ],
  },
  /** A chip (see chips.ts): its Markdown, kept as written. */
  chip: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    attrs: { source: { default: "" } },
    leafText: (node) => String(node.attrs.source),
    // Copied chips paste back as chips.
    parseDOM: [
      {
        tag: "span.artifact-chip[data-source]",
        getAttrs: (dom) => {
          const source = dom.getAttribute("data-source");
          return source !== null && parseChip(source) !== undefined
            ? { source }
            : false;
        },
      },
    ],
    toDOM: (node) => [
      "span",
      { class: "artifact-chip", "data-source": node.attrs.source },
      String(node.attrs.source),
    ],
  },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
} satisfies Record<string, NodeSpec>;

const marks = {
  em: {
    attrs: { markup: { default: "*" } },
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
  },
  strong: {
    attrs: { markup: { default: "**" } },
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },
  strike: {
    attrs: { markup: { default: "~~" } },
    parseDOM: [{ tag: "s" }, { tag: "del" }],
    toDOM: () => ["s", 0],
  },
  link: {
    attrs: {
      href: {},
      title: { default: null },
      /** `autolink` for `<url>`, `linkify` for a bare URL, else `''`. */
      markup: { default: "" },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        // A pasted link keeps its target only when it is safe to follow.
        getAttrs: (dom) => {
          const href = dom.getAttribute("href") ?? "";
          return safeHref(href)
            ? { href, title: dom.getAttribute("title") }
            : false;
        },
      },
    ],
    toDOM: (mark) => [
      "a",
      {
        ...(safeHref(String(mark.attrs.href)) ? { href: mark.attrs.href } : {}),
        ...(mark.attrs.title === null ? {} : { title: mark.attrs.title }),
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      },
      0,
    ],
  },
  code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
} satisfies Record<string, MarkSpec>;

export const artifactSchema = new Schema({ nodes, marks });

const markdownIt = MarkdownIt("default", { html: false, linkify: true });

/**
 * An image's alt text as written, unescaped: its label's text, not its
 * source (`![a \\[b\\]](x)` is "a [b]").
 */
const altText = (tokens: ReadonlyArray<Token>): string =>
  tokens
    .map((token) =>
      token.type === "text" ||
      token.type === "text_special" ||
      token.type === "code_inline"
        ? token.content
        : token.type === "softbreak" || token.type === "hardbreak"
          ? "\n"
          : altText(token.children ?? []),
    )
    .join("");

/**
 * Chips read as one token each, before links (a mention is link-shaped).
 * Inside a table cell a chip's `|` arrives escaped as `\|`.
 */
markdownIt.inline.ruler.before("link", "artifact_chip", (state, silent) => {
  const rest = state.src.slice(state.pos);
  let raw: string | undefined;
  if (rest.startsWith("{{")) {
    const end = rest.indexOf("}}", 2);
    const newline = rest.indexOf("\n");
    if (end !== -1 && (newline === -1 || newline > end))
      raw = rest.slice(0, end + 2);
  } else if (rest.startsWith("@["))
    raw = /^@\[[^\]\n]+\]\((?:user:[A-Za-z0-9_-]+|agent)\)/.exec(rest)?.[0];
  if (raw === undefined) return false;
  const source = raw.replace(/\\\|/g, "|");
  if (parseChip(source) === undefined) return false;
  if (!silent) {
    const token = state.push("artifact_chip", "", 0);
    token.content = source;
  }
  state.pos += raw.length;
  return true;
});

// ---------------------------------------------------------------------------
// Source text

const LINE = /\r\n|\r|\n/g;

/** The source's lines, each with its own line terminator (the last may lack one). */
const splitLines = (source: string): ReadonlyArray<string> => {
  const lines: string[] = [];
  let start = 0;
  for (const match of source.matchAll(LINE)) {
    const end = (match.index ?? 0) + match[0].length;
    lines.push(source.slice(start, end));
    start = end;
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
};

const isBlank = (line: string) => /^[ \t]*(?:\r\n|\r|\n)?$/.test(line);
const terminator = (line: string) => /(?:\r\n|\r|\n)$/.exec(line)?.[0] ?? "";
const withoutTerminator = (line: string) =>
  line.slice(0, line.length - terminator(line).length);

/**
 * Lines `[start, end)` as one block's source, without trailing blank lines or
 * its last terminator, and the end of its content.
 */
const blockSource = (
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
): { readonly source: string; readonly contentEnd: number } => {
  let contentEnd = end;
  while (contentEnd > start + 1 && isBlank(lines[contentEnd - 1] ?? "")) {
    contentEnd -= 1;
  }
  const body = lines.slice(start, contentEnd);
  const last = body.length - 1;
  return {
    source: body
      .map((line, index) => (index === last ? withoutTerminator(line) : line))
      .join(""),
    contentEnd,
  };
};

/** The line terminator a document uses: its first, else `\n`. */
const documentEol = (source: string) => /\r\n|\r|\n/.exec(source)?.[0] ?? "\n";

/** Converts the bare `\n` line ends of freshly written Markdown to `eol`. */
const withEol = (text: string, eol: string) =>
  eol === "\n" ? text : text.replace(/(?<!\r)\n/g, eol);

// ---------------------------------------------------------------------------
// Parsing

/** What a block was parsed from, kept so an unchanged block is written back as it was. */
interface SourceEntry {
  /** The block as parsed; an unchanged block still equals it. */
  readonly node: Node;
  /** Its source text, without its last line terminator. */
  readonly source: string;
  /** The line terminator and blank lines between it and the next block. */
  readonly gap: string;
  /** The key of the block that followed it in the source; null for the last. */
  readonly nextKey: number | null;
  /** A table's header row: the delimiter row under it, as written. */
  readonly delimiter?: string;
}

interface SourceRegistry {
  nextKey: number;
  readonly entries: Map<number, SourceEntry>;
}

interface ParseContext {
  readonly tokens: ReadonlyArray<Token>;
  readonly lines: ReadonlyArray<string>;
  readonly registry: SourceRegistry | undefined;
  index: number;
}

const TASK = /^\[([ xX])\](?: |$)/;

type MarkStack = ReadonlyArray<Mark>;

const markOf = (token: Token): Mark | undefined => {
  const schema = artifactSchema;
  switch (token.type) {
    case "em_open":
      return schema.marks.em.create({ markup: token.markup });
    case "strong_open":
      return schema.marks.strong.create({ markup: token.markup });
    case "s_open":
      return schema.marks.strike.create({ markup: token.markup });
    case "link_open":
      return schema.marks.link.create({
        href: token.attrGet("href") ?? "",
        title: token.attrGet("title"),
        markup:
          token.markup === "autolink" || token.markup === "linkify"
            ? token.markup
            : "",
      });
    default:
      return undefined;
  }
};

const closesMark: Record<string, MarkType | undefined> = {
  em_close: artifactSchema.marks.em,
  strong_close: artifactSchema.marks.strong,
  s_close: artifactSchema.marks.strike,
  link_close: artifactSchema.marks.link,
};

/** Inline tokens to nodes. `hardBreaks` is false where Markdown has none (headings, cells). */
const inlineNodes = (
  children: ReadonlyArray<Token>,
  hardBreaks: boolean,
): Node[] => {
  const out: Node[] = [];
  let active: MarkStack = [];
  const text = (value: string, marks: MarkStack) => {
    if (value === "") return;
    out.push(artifactSchema.text(value, marks));
  };
  for (const token of children) {
    const opened = markOf(token);
    if (opened !== undefined) {
      active = opened.addToSet(active);
      continue;
    }
    const closed = closesMark[token.type];
    if (closed !== undefined) {
      active = closed.removeFromSet(active);
      continue;
    }
    switch (token.type) {
      case "text":
      case "text_special":
      case "html_inline":
        text(token.content, active);
        break;
      case "softbreak":
        text("\n", active);
        break;
      case "hardbreak":
        if (hardBreaks) out.push(artifactSchema.nodes.hard_break.create());
        else text("\n", active);
        break;
      case "code_inline":
        text(
          token.content,
          artifactSchema.marks.code.create().addToSet(active),
        );
        break;
      case "artifact_chip":
        out.push(
          artifactSchema.nodes.chip.create(
            { source: token.content },
            null,
            active,
          ),
        );
        break;
      case "image":
        out.push(
          artifactSchema.nodes.image.create(
            {
              src: token.attrGet("src") ?? "",
              alt: altText(token.children ?? []),
              title: token.attrGet("title"),
            },
            null,
            active,
          ),
        );
        break;
      default:
        break;
    }
  }
  // Adjacent text with the same marks becomes one node.
  return Fragment.from(out).content.slice();
};

const registerSource = (
  context: ParseContext,
  node: Node,
  map: readonly [number, number] | null | undefined,
  dedent: boolean,
): Node => {
  const registry = context.registry;
  if (registry === undefined || map === null || map === undefined) return node;
  const { source } = blockSource(context.lines, map[0], map[1]);
  let text = source;
  if (dedent) {
    const indent = /^ */.exec(source)?.[0].length ?? 0;
    if (indent > 0) {
      const strip = new RegExp(`^ {${indent}}`);
      text = splitLines(source)
        .map((line) => line.replace(strip, ""))
        .join("");
    }
  }
  const key = registry.nextKey;
  registry.nextKey += 1;
  const keyed = node.type.create(
    { ...node.attrs, key },
    node.content,
    node.marks,
  );
  registry.entries.set(key, {
    node: keyed,
    source: text,
    gap: "",
    nextKey: null,
  });
  return keyed;
};

/** Links each registered sibling to the next and records the gap between them. */
const linkSiblings = (
  context: ParseContext,
  siblings: ReadonlyArray<{
    readonly node: Node;
    readonly map: readonly [number, number] | null | undefined;
  }>,
  trailingEnd: number | undefined,
) => {
  const registry = context.registry;
  if (registry === undefined) return;
  siblings.forEach(({ node, map }, index) => {
    const key = node.attrs.key;
    if (typeof key !== "number" || map === null || map === undefined) return;
    const entry = registry.entries.get(key);
    if (entry === undefined) return;
    const next = siblings[index + 1];
    const { contentEnd } = blockSource(context.lines, map[0], map[1]);
    const gapEnd = next?.map?.[0] ?? trailingEnd ?? contentEnd;
    const gap =
      terminator(context.lines[contentEnd - 1] ?? "") +
      context.lines.slice(contentEnd, gapEnd).join("");
    const nextKey = next?.node.attrs.key;
    registry.entries.set(key, {
      ...entry,
      gap,
      nextKey: typeof nextKey === "number" ? nextKey : null,
    });
  });
};

const tokenMap = (token: Token): readonly [number, number] | null =>
  token.map === null ? null : [token.map[0], token.map[1]];

/** Parses block tokens until the closing token `until` (or the end). */
const parseBlocks = (
  context: ParseContext,
  until: string | undefined,
  quoted: boolean,
): Array<{ node: Node; map: readonly [number, number] | null }> => {
  const out: Array<{ node: Node; map: readonly [number, number] | null }> = [];
  const { nodes: types } = artifactSchema;
  while (context.index < context.tokens.length) {
    const token = itemAt(context.tokens, context.index);
    if (until !== undefined && token.type === until) {
      context.index += 1;
      return out;
    }
    context.index += 1;
    const map = tokenMap(token);
    switch (token.type) {
      case "paragraph_open": {
        const inline = itemAt(context.tokens, context.index);
        context.index += 2;
        out.push({
          node: types.paragraph.create(
            null,
            inlineNodes(inline.children ?? [], true),
          ),
          map,
        });
        break;
      }
      case "heading_open": {
        const inline = itemAt(context.tokens, context.index);
        context.index += 2;
        out.push({
          node: types.heading.create(
            { level: Number(token.tag.slice(1)), markup: token.markup },
            inlineNodes(inline.children ?? [], false),
          ),
          map,
        });
        break;
      }
      case "blockquote_open": {
        const children = parseBlocks(context, "blockquote_close", true);
        out.push({
          node: types.blockquote.create(
            null,
            children.length === 0
              ? types.paragraph.create()
              : children.map((child) => child.node),
          ),
          map,
        });
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const tight = context.tokens[context.index + 1]?.hidden === true;
        const ordered = token.type === "ordered_list_open";
        const items = parseBlocks(
          context,
          ordered ? "ordered_list_close" : "bullet_list_close",
          quoted,
        );
        linkSiblings(context, items, undefined);
        out.push({
          node: ordered
            ? types.ordered_list.create(
                {
                  order: Number(token.attrGet("start") ?? 1),
                  tight,
                  markup: token.markup,
                },
                items.map((item) => item.node),
              )
            : types.bullet_list.create(
                { tight, markup: token.markup },
                items.map((item) => item.node),
              ),
          map,
        });
        break;
      }
      case "list_item_open": {
        const children = parseBlocks(context, "list_item_close", quoted).map(
          (child) => child.node,
        );
        let checked: boolean | null = null;
        const first = children[0];
        if (first?.type === types.paragraph) {
          const lead = first.firstChild;
          const match =
            lead?.isText === true && lead.marks.length === 0
              ? TASK.exec(lead.text ?? "")
              : null;
          if (match !== null && lead !== null) {
            checked = match[1] !== " ";
            const rest = (lead.text ?? "").slice(match[0].length);
            const content = first.content.replaceChild(
              0,
              artifactSchema.text(rest === "" ? " " : rest),
            );
            children[0] = first.copy(rest === "" ? content.cut(1) : content);
          }
        }
        if (children[0]?.type !== types.paragraph)
          children.unshift(types.paragraph.create());
        const item = types.list_item.create({ checked }, children);
        out.push({
          node: quoted ? item : registerSource(context, item, map, true),
          map,
        });
        break;
      }
      case "fence":
      case "code_block": {
        const content = token.content.replace(/\n$/, "");
        out.push({
          node: types.code_block.create(
            {
              params: token.type === "fence" ? token.info : "",
              markup: token.type === "fence" ? token.markup : "indent",
            },
            content === "" ? null : artifactSchema.text(content),
          ),
          map,
        });
        break;
      }
      case "hr":
        out.push({
          node: types.horizontal_rule.create({ markup: token.markup }),
          map,
        });
        break;
      case "table_open":
        out.push({ node: parseTable(context), map });
        break;
      case "html_block":
        out.push({
          node: types.markdown_source.create({
            source: token.content.replace(/\n$/, ""),
          }),
          map,
        });
        break;
      default:
        break;
    }
  }
  return out;
};

const parseTable = (context: ParseContext): Node => {
  const { nodes: types } = artifactSchema;
  const rows: Node[] = [];
  let cells: Node[] = [];
  let rowMap: readonly [number, number] | null = null;
  while (context.index < context.tokens.length) {
    const token = itemAt(context.tokens, context.index);
    context.index += 1;
    if (token.type === "table_close") break;
    if (token.type === "tr_open") {
      cells = [];
      rowMap = tokenMap(token);
    }
    if (token.type === "tr_close") {
      const row = types.table_row.create(null, cells);
      // A row's line is kept only for a table at the top level: inside a
      // list or quote its line carries the container's prefix.
      const line = rowMap === null ? "" : (context.lines[rowMap[0]] ?? "");
      const keyed = /^[ \t>]/.test(line)
        ? row
        : registerSource(context, row, rowMap, false);
      const key = keyed.attrs.key;
      const entry =
        typeof key === "number"
          ? context.registry?.entries.get(key)
          : undefined;
      if (rows.length === 0 && entry !== undefined && rowMap !== null)
        context.registry?.entries.set(key, {
          ...entry,
          delimiter: withoutTerminator(context.lines[rowMap[0] + 1] ?? ""),
        });
      rows.push(keyed);
    }
    if (token.type === "th_open" || token.type === "td_open") {
      const inline = itemAt(context.tokens, context.index);
      context.index += 2;
      const align =
        /text-align:\s*(left|center|right)/.exec(
          token.attrGet("style") ?? "",
        )?.[1] ?? null;
      cells.push(
        (token.type === "th_open"
          ? types.table_header
          : types.table_cell
        ).create(
          { align },
          artifactSchema.nodes.paragraph.create(
            null,
            inlineNodes(inline.children ?? [], false),
          ),
        ),
      );
    }
  }
  return types.table.create(null, rows);
};

interface ParsedDocument {
  readonly doc: Node;
  readonly lead: string;
  /** The text after the last block when there are no blocks. */
  readonly eol: string;
}

/**
 * A table row's dropdown, toggle, and project chips with each bare `|`
 * escaped, as a cell needs (#1865): an agent that writes
 * `| {{dropdown:Todo|*Doing}} |` meant one chip, not two cells. Only what
 * markdown-it reads changes; the lines kept for each block are the source
 * as written, so an untouched row saves byte for byte.
 */
const escapeChipPipes = (source: string) =>
  source.includes("{{")
    ? source.replace(/^([ \t]*\|.*)$/gmu, (row: string) =>
        row.replace(
          /\{\{(?:dropdown|toggle|project)(?:#[A-Za-z0-9_-]{1,40})?:[^\n]*?\}\}/gu,
          (chip) => chip.replace(/(?<!\\)\|/gu, "\\|"),
        ),
      )
    : source;

/**
 * The top-level blocks with their source lines. Text between blocks that is
 * not blank (reference definitions) becomes a `markdown_source` block.
 */
const parseDocument = (
  source: string,
  registry: SourceRegistry | undefined,
): ParsedDocument => {
  const lines = splitLines(source);
  const context: ParseContext = {
    tokens: markdownIt.parse(escapeChipPipes(source), {}),
    lines,
    registry,
    index: 0,
  };
  const parsed = parseBlocks(context, undefined, false);
  const blocks: Array<{ node: Node; map: readonly [number, number] | null }> =
    [];
  const sourceBlock = (start: number, end: number) => {
    let first = start;
    let last = end;
    while (first < last && isBlank(itemAt(lines, first))) first += 1;
    while (last > first && isBlank(itemAt(lines, last - 1))) last -= 1;
    if (first === last) return;
    const { source: text } = blockSource(lines, first, last);
    blocks.push({
      node: artifactSchema.nodes.markdown_source.create({ source: text }),
      map: [first, last],
    });
  };
  let cursor = 0;
  for (const block of parsed) {
    if (block.map !== null) {
      sourceBlock(cursor, block.map[0]);
      cursor = blockSource(lines, block.map[0], block.map[1]).contentEnd;
    }
    blocks.push(block);
  }
  sourceBlock(cursor, lines.length);
  const firstStart = blocks[0]?.map?.[0] ?? lines.length;
  const keyed = blocks.map((block) => ({
    node: registerSource(context, block.node, block.map, false),
    map: block.map,
  }));
  linkSiblings(context, keyed, lines.length);
  const children = keyed.map((block) => block.node);
  return {
    doc: artifactSchema.nodes.doc.create(
      null,
      children.length === 0
        ? artifactSchema.nodes.paragraph.create()
        : children,
    ),
    lead: lines.slice(0, firstStart).join(""),
    eol: documentEol(source),
  };
};

/** Parses Markdown without recording its source (for comparisons). */
export const parseArtifactMarkdown = (source: string): Node =>
  parseDocument(source, undefined).doc;

/**
 * The source of each top-level block and the blank lines after it, the way
 * the codec divides a document. Text before the first block is `lead`.
 */
export const topLevelSources = (
  source: string,
): {
  readonly lead: string;
  readonly blocks: ReadonlyArray<{
    readonly source: string;
    readonly gap: string;
  }>;
} => {
  const registry: SourceRegistry = { nextKey: 0, entries: new Map() };
  const { doc, lead } = parseDocument(source, registry);
  const blocks: Array<{ source: string; gap: string }> = [];
  doc.forEach((node) => {
    const entry =
      typeof node.attrs.key === "number"
        ? registry.entries.get(node.attrs.key)
        : undefined;
    if (entry !== undefined)
      blocks.push({ source: entry.source, gap: entry.gap });
  });
  return { lead, blocks };
};

// ---------------------------------------------------------------------------
// Comparing content

// A list's tightness only spaces its items; the editor shows both alike, and
// a list item holding a table or code block can only be written loose.
const STYLE_ATTRS = new Set(["key", "markup", "tight"]);

/** A node's content as plain data, without source keys or markup style. */
const contentData = (node: Node): unknown => ({
  type: node.type.name,
  attrs: Object.fromEntries(
    Object.entries(node.attrs).filter(([name]) => !STYLE_ATTRS.has(name)),
  ),
  marks: node.marks.map((mark) => ({
    type: mark.type.name,
    attrs: Object.fromEntries(
      Object.entries(mark.attrs).filter(([name]) => !STYLE_ATTRS.has(name)),
    ),
  })),
  text: node.text,
  content: node.content.content.map(contentData),
});

/** Whether two documents or blocks hold the same content, ignoring style. */
export const sameArtifactContent = (a: Node, b: Node): boolean =>
  JSON.stringify(contentData(a)) === JSON.stringify(contentData(b));

// ---------------------------------------------------------------------------
// Writing blocks afresh

type Escape = "none" | "full";

/** Writes inline content, escaping only line starts and table pipes when `none`. */
class InlineState extends MarkdownSerializerState {
  escapeMode: Escape = "full";
  inCell = false;

  override text(value: string, escaping = true): void {
    const self = this as unknown as { out: string; atBlockStart: boolean };
    const lines = value.split("\n");
    lines.forEach((line, index) => {
      this.write();
      if (
        !escaping &&
        line.startsWith("[") &&
        /(^|[^\\])!$/.test(self.out.slice(-2))
      )
        self.out = `${self.out.slice(0, -1)}\\!`;
      self.out += escaping
        ? this.esc(line, index > 0 || self.atBlockStart)
        : line;
      if (index !== lines.length - 1) self.out += "\n";
    });
  }

  override esc(text: string, startOfLine = false): string {
    let out =
      this.escapeMode === "none"
        ? text
        : super
            .esc(text, startOfLine)
            .replace(/<(?=[A-Za-z/!?])/g, "\\<")
            .replace(/^(\s*\d+)\)(\s|$)/, startOfLine ? "$1\\)$2" : "$&")
            .replace(/^(\s*)([=]+\s*)$/, startOfLine ? "$1\\$2" : "$&");
    if (this.inCell) out = out.replace(/(?<!\\)\|/g, "\\|");
    return out;
  }
}

const isPlainUrl = (link: Mark, parent: Node, index: number) => {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (
    !content.isText ||
    content.text !== link.attrs.href ||
    content.marks[content.marks.length - 1] !== link
  )
    return false;
  return (
    index === parent.childCount - 1 ||
    !link.isInSet(parent.child(index + 1).marks)
  );
};

const backticks = (text: string) => {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length);
  return longest;
};

const quoteTitle = (title: string) => {
  const wrap = !title.includes('"') ? '""' : !title.includes("'") ? "''" : "()";
  return `${wrap[0]}${title}${wrap[1]}`;
};

type InlineStateConstructor = new (
  nodes: MarkdownSerializer["nodes"],
  marks: MarkdownSerializer["marks"],
  options: { readonly hardBreakNodeName: string },
) => InlineState;

const inlineSerializer = new MarkdownSerializer(
  {
    text: (state, node) => {
      const self = state as unknown as { inAutolink: boolean | undefined };
      state.text(node.text ?? "", !self.inAutolink);
    },
    image: (state, node) => {
      state.write(
        `![${state.esc(node.attrs.alt ?? "")}](${String(node.attrs.src)
          // A destination ends at whitespace and cannot hold `<` or `>`;
          // percent-encoded, the same URL stays one destination.
          .replace(/[\s<>]/g, (character) => encodeURIComponent(character))
          .replace(/[()]/g, "\\$&")}${
          node.attrs.title ? ` ${quoteTitle(node.attrs.title)}` : ""
        })`,
      );
    },
    chip: (state, node) => {
      const source = String(node.attrs.source);
      state.write(
        (state as unknown as InlineState).inCell
          ? source.replace(/\|/g, "\\|")
          : source,
      );
    },
    hard_break: (state, node, parent, index) => {
      for (let i = index + 1; i < parent.childCount; i += 1)
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
    },
  },
  {
    em: {
      open: (_state, mark) => mark.attrs.markup || "*",
      close: (_state, mark) => mark.attrs.markup || "*",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    strong: {
      open: (_state, mark) => mark.attrs.markup || "**",
      close: (_state, mark) => mark.attrs.markup || "**",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    strike: {
      open: (_state, mark) => mark.attrs.markup || "~~",
      close: (_state, mark) => mark.attrs.markup || "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    link: {
      open: (state, mark, parent, index) => {
        const self = state as unknown as { inAutolink: boolean | undefined };
        const plain = isPlainUrl(mark, parent, index);
        self.inAutolink = plain;
        if (!plain) return "[";
        return mark.attrs.markup === "linkify" ? "" : "<";
      },
      close: (state, mark) => {
        const self = state as unknown as { inAutolink: boolean | undefined };
        const plain = self.inAutolink;
        self.inAutolink = undefined;
        if (plain) return mark.attrs.markup === "linkify" ? "" : ">";
        const href = String(mark.attrs.href).replace(/[()"]/g, "\\$&");
        return `](${href}${mark.attrs.title ? ` ${quoteTitle(mark.attrs.title)}` : ""})`;
      },
      mixable: true,
    },
    code: {
      open: (_state, _mark, parent, index) => {
        const text = parent.child(index).text ?? "";
        const ticks = "`".repeat(backticks(text) + 1);
        return /^`|`$/.test(text) || /^ .* $/.test(text) ? `${ticks} ` : ticks;
      },
      close: (_state, _mark, parent, index) => {
        const text = parent.child(index - 1).text ?? "";
        const ticks = "`".repeat(backticks(text) + 1);
        return /^`|`$/.test(text) || /^ .* $/.test(text) ? ` ${ticks}` : ticks;
      },
      escape: false,
    },
  },
);

const inline = (node: Node, escapeMode: Escape, inCell = false): string => {
  const state = new (InlineState as unknown as InlineStateConstructor)(
    inlineSerializer.nodes,
    inlineSerializer.marks,
    {
      hardBreakNodeName: "hard_break",
    },
  );
  state.escapeMode = escapeMode;
  state.inCell = inCell;
  state.renderInline(node);
  return (state as unknown as { out: string }).out;
};

/** Prefixes the first line with `first` and the rest with `rest`; blank lines keep no prefix. */
const indentLines = (text: string, first: string, rest: string) =>
  splitLines(text)
    .map((line, index) => {
      if (isBlank(line)) return index === 0 ? first.trimEnd() + line : line;
      return (index === 0 ? first : rest) + line;
    })
    .join("");

interface WriteContext {
  readonly registry: SourceRegistry | undefined;
  readonly escape: Escape;
}

const entryFor = (context: WriteContext, node: Node) => {
  const key = node.attrs.key;
  return typeof key === "number"
    ? context.registry?.entries.get(key)
    : undefined;
};

/** The unchanged source of `node`, if it has one. */
const pristineSource = (context: WriteContext, node: Node) => {
  const entry = entryFor(context, node);
  return entry?.node.eq(node) ? entry.source : undefined;
};

/** Children joined by their original gaps where they still follow each other. */
const joinBlocks = (
  context: WriteContext,
  children: ReadonlyArray<Node>,
  write: (node: Node, index: number) => string | undefined,
  separator: (previous: Node, next: Node) => string,
): string => {
  let out = "";
  let previous: Node | undefined;
  children.forEach((child, index) => {
    const text = write(child, index);
    if (text === undefined) return;
    if (previous !== undefined) {
      const entry = entryFor(context, previous);
      out +=
        // A new block (no key) never takes the gap of the block before it,
        // which may be the document's final line end.
        entry !== undefined &&
        entry.nextKey !== null &&
        entry.nextKey === child.attrs.key
          ? entry.gap
          : separator(previous, child);
    }
    out += text;
    previous = child;
  });
  return out;
};

const childrenOf = (node: Node): Node[] => node.content.content.slice();

const fenceFor = (markup: string, params: string, content: string) => {
  const char = markup.startsWith("~") || params.includes("`") ? "~" : "`";
  let longest = 0;
  for (const match of content.matchAll(new RegExp(`^ {0,3}(\\${char}+)`, "gm")))
    longest = Math.max(longest, itemAt(match, 1).length);
  const length = Math.max(
    3,
    markup.startsWith(char) ? markup.length : 3,
    longest + 1,
  );
  return char.repeat(length);
};

const ITEM_TASK = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/;

const writeListItem = (
  context: WriteContext,
  item: Node,
  marker: string,
  tight: boolean,
): string => {
  const pristine = pristineSource(context, item);
  if (pristine !== undefined) return pristine;
  const entry = entryFor(context, item);
  if (
    entry !== undefined &&
    entry.node.attrs.checked !== null &&
    item.attrs.checked !== null &&
    entry.node.type
      .create(
        { ...entry.node.attrs, checked: item.attrs.checked },
        entry.node.content,
      )
      .eq(item) &&
    ITEM_TASK.test(entry.source)
  )
    return entry.source.replace(
      ITEM_TASK,
      `$1[${item.attrs.checked === true ? "x" : " "}]`,
    );
  const task =
    item.attrs.checked === null ? "" : item.attrs.checked ? "[x] " : "[ ] ";
  // A blank line between the item's blocks, so none runs into the line
  // before it (a paragraph's lazy continuation, `---` making a heading, a
  // table read as text); only a nested list may follow the item's text
  // directly in a tight list.
  const body = joinBlocks(
    context,
    childrenOf(item),
    (child) => writeBlock(context, child),
    (previous, next) =>
      tight &&
      previous.type.name === "paragraph" &&
      (next.type.name === "bullet_list" || next.type.name === "ordered_list")
        ? "\n"
        : "\n\n",
  );
  const first = `${marker} ${task}`;
  const indent = " ".repeat(marker.length + 1);
  // An item whose first line is empty keeps its marker on a line of its own,
  // so the next block does not start on the marker's line; a checklist
  // marker also needs a blank line, or a paragraph would run into `[ ]`.
  const opening = item.firstChild;
  if (
    opening?.type.name === "paragraph" &&
    opening.childCount === 0 &&
    item.childCount > 1 &&
    body.trim() !== ""
  )
    return `${first.trimEnd()}\n${task === "" ? "" : "\n"}${indentLines(body, indent, indent)}`.replace(
      /[ \t]+$/gm,
      "",
    );
  const text = indentLines(body, first, indent);
  return text.trimEnd() === "" ? first.trimEnd() : text.replace(/[ \t]+$/, "");
};

const writeList = (context: WriteContext, list: Node): string => {
  const ordered = list.type.name === "ordered_list";
  const tight = list.attrs.tight !== false;
  const markup = list.attrs.markup || (ordered ? "." : "-");
  return joinBlocks(
    context,
    childrenOf(list),
    (item, index) =>
      writeListItem(
        context,
        item,
        ordered ? `${Number(list.attrs.order) + index}${markup}` : markup,
        tight,
      ),
    () => (tight ? "\n" : "\n\n"),
  );
};

const writeTable = (context: WriteContext, table: Node): string => {
  const rows = childrenOf(table);
  const header = rows[0];
  if (header === undefined) return "";
  const line = (row: Node) =>
    pristineSource(context, row) ??
    `| ${childrenOf(row)
      .map((cell) => inline(cell.firstChild ?? cell, context.escape, true))
      .join(" | ")} |`;
  const headerEntry = entryFor(context, header);
  const sameColumns =
    headerEntry?.delimiter !== undefined &&
    headerEntry.node.childCount === header.childCount &&
    childrenOf(header).every(
      (cell, index) =>
        headerEntry.node.child(index).attrs.align === cell.attrs.align,
    );
  if (sameColumns && headerEntry.delimiter !== undefined)
    return [
      line(header),
      headerEntry.delimiter,
      ...rows.slice(1).map(line),
    ].join("\n");
  const delimiter = `| ${childrenOf(header)
    .map((cell) => {
      switch (cell.attrs.align) {
        case "left":
          return ":---";
        case "center":
          return ":---:";
        case "right":
          return "---:";
        default:
          return "---";
      }
    })
    .join(" | ")} |`;
  return [line(header), delimiter, ...rows.slice(1).map(line)].join("\n");
};

/** A block's Markdown, without a final line end; undefined writes nothing. */
const writeBlock = (context: WriteContext, node: Node): string | undefined => {
  const pristine = pristineSource(context, node);
  if (pristine !== undefined) return pristine;
  switch (node.type.name) {
    case "paragraph":
      return node.childCount === 0 ? undefined : inline(node, context.escape);
    case "heading": {
      const text = inline(node, context.escape);
      const markup = String(node.attrs.markup);
      if ((markup === "=" || markup === "-") && text.trim() !== "") {
        const last = text.split("\n").at(-1) ?? "";
        return `${text}\n${markup.repeat(Math.max(3, last.length))}`;
      }
      const hashes = "#".repeat(Number(node.attrs.level));
      const flat = text.replace(/\n/g, " ");
      return flat === "" ? hashes : `${hashes} ${flat}`;
    }
    case "blockquote": {
      const body = joinBlocks(
        context,
        childrenOf(node),
        (child) => writeBlock(context, child),
        () => "\n\n",
      );
      return splitLines(body === "" ? " " : body)
        .map((line) => (isBlank(line) ? `>${line}` : `> ${line}`))
        .join("");
    }
    case "code_block": {
      const content = node.textContent;
      const params = String(node.attrs.params ?? "");
      if (
        node.attrs.markup === "indent" &&
        params === "" &&
        content.trim() !== ""
      )
        return indentLines(content, "    ", "    ");
      const fence = fenceFor(String(node.attrs.markup), params, content);
      return content === ""
        ? `${fence}${params}\n${fence}`
        : `${fence}${params}\n${content}\n${fence}`;
    }
    case "horizontal_rule":
      return String(node.attrs.markup || "---");
    case "markdown_source":
      return String(node.attrs.source);
    case "bullet_list":
    case "ordered_list":
      return writeList(context, node);
    case "table":
      return writeTable(context, node);
    default:
      return node.textContent;
  }
};

/**
 * A top-level block written afresh: unescaped when that parses back to the
 * same content, else escaped.
 */
const writeTopLevel = (
  registry: SourceRegistry | undefined,
  node: Node,
): string | undefined => {
  const plain = writeBlock({ registry, escape: "none" }, node);
  if (plain === undefined || pristineSource({ registry, escape: "none" }, node))
    return plain;
  const reparsed = parseArtifactMarkdown(plain);
  if (reparsed.childCount === 1 && sameArtifactContent(reparsed.child(0), node))
    return plain;
  return writeBlock({ registry, escape: "full" }, node);
};

const serialize = (
  doc: Node,
  registry: SourceRegistry | undefined,
  document: {
    readonly lead: string;
    readonly eol: string;
    readonly end: string;
  },
): string => {
  const context: WriteContext = { registry, escape: "full" };
  const children = childrenOf(doc);
  const written = children.map((child) => {
    const text = writeTopLevel(registry, child);
    return text === undefined || pristineSource(context, child) !== undefined
      ? text
      : withEol(text, document.eol);
  });
  const body = joinBlocks(
    context,
    children,
    (_child, index) => written[index],
    () => document.eol + document.eol,
  );
  let last: Node | undefined;
  children.forEach((child, index) => {
    if (written[index] !== undefined) last = child;
  });
  if (last === undefined) return document.lead;
  const entry = entryFor(context, last);
  const end =
    entry !== undefined && entry.nextKey === null ? entry.gap : document.end;
  return document.lead + body + end;
};

/** Writes every block afresh, ignoring any source (for tests and export). */
export const serializeArtifactMarkdownFresh = (doc: Node): string =>
  serialize(doc, undefined, { lead: "", eol: "\n", end: "\n" });

export interface ArtifactMarkdownCodec {
  /** Parses Markdown, recording its source so unchanged blocks are written back as they were. */
  readonly parse: (markdown: string) => Node;
  /** The document's Markdown, keeping the source of every unchanged block. */
  readonly serialize: (doc: Node) => string;
}

/** One editor's codec: it remembers the source of every document it parsed. */
export const createArtifactMarkdownCodec = (): ArtifactMarkdownCodec => {
  const registry: SourceRegistry = { nextKey: 1, entries: new Map() };
  let document = { lead: "", eol: "\n", end: "\n" };
  return {
    parse: (markdown) => {
      const parsed = parseDocument(markdown, registry);
      document = {
        lead: parsed.lead,
        eol: parsed.eol,
        end:
          markdown === "" || /(?:\r\n|\r|\n)$/.test(markdown) ? parsed.eol : "",
      };
      return parsed.doc;
    },
    serialize: (doc) => serialize(doc, registry, document),
  };
};

/**
 * A list's items or a table's rows (its header and delimiter rows as one),
 * each with the line end and blank lines after it, for merging a block part
 * by part. Undefined for any other block. `kind` tells lists of different
 * types or markers apart.
 */
export const blockParts = (
  source: string,
):
  | {
      readonly kind: string;
      readonly parts: ReadonlyArray<{
        readonly source: string;
        readonly gap: string;
      }>;
    }
  | undefined => {
  const tokens = markdownIt.parse(escapeChipPipes(source), {});
  const first = tokens[0];
  if (first === undefined || first.level !== 0) return undefined;
  const lines = splitLines(source);
  const part = (start: number, end: number, last: boolean) => {
    const { source: text, contentEnd } = blockSource(lines, start, end);
    return {
      source: text,
      gap: last
        ? ""
        : terminator(lines[contentEnd - 1] ?? "") +
          lines.slice(contentEnd, end).join(""),
    };
  };
  if (first.type === "bullet_list_open" || first.type === "ordered_list_open") {
    const closing = first.type.replace("_open", "_close");
    if (
      tokens.findIndex((token) => token.type === closing) !==
      tokens.length - 1
    )
      return undefined;
    const starts = tokens.flatMap((token) =>
      token.type === "list_item_open" && token.level === 1
        ? [token.map?.[0] ?? 0]
        : [],
    );
    return {
      kind: `${first.type}:${first.markup}`,
      parts: starts.map((start, index) =>
        part(
          start,
          starts[index + 1] ?? lines.length,
          index === starts.length - 1,
        ),
      ),
    };
  }
  if (first.type === "table_open") {
    if (tokens.at(-1)?.type !== "table_close" || lines.length < 2)
      return undefined;
    const rows = [
      0,
      ...Array.from({ length: lines.length - 2 }, (_, i) => i + 2),
    ];
    return {
      kind: "table",
      parts: rows.map((start, index) =>
        part(start, rows[index + 1] ?? lines.length, index === rows.length - 1),
      ),
    };
  }
  return undefined;
};
