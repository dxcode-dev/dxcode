/**
 * Every document the editor can make saves to Markdown that reads back as
 * the same document (#1651: a table made inside a checklist item came back
 * as pipe text after the pane moved and the editor reloaded).
 *
 * Generated: each block the editor inserts, inside each container it can
 * sit in (the top level, a bulleted, numbered, or checklist item, a quote,
 * and those nested), written two ways: afresh, and as an edit of a parsed
 * document (the path a save takes).
 *
 * Ways it can fail, each a generated case below:
 *  1. A block inside a list item or quote loses its indentation or `>`, so
 *     it reads back outside its container, or as text.
 *  2. A table whose header cells are all empty is not a table to Markdown.
 *  3. A list item whose first paragraph is empty glues its marker to the
 *     next block's first line (`- | a |`, `- ```ts`).
 *  4. A code block, `dx-view`, image, chip, or divider changes inside a
 *     container.
 *  5. A block added after the document's untouched last block is glued to
 *     it by the last block's final line end (an image dropped at the end
 *     read back as part of the paragraph above).
 *  6. An empty line the editor shows between blocks merges its neighbours.
 *     (Markdown has no empty paragraph, so the line itself reads back as
 *     nothing; the comparison drops empty lines the schema does not need.)
 */
import { Fragment, type Node } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  createArtifactMarkdownCodec,
  parseArtifactMarkdown,
  sameArtifactContent,
  serializeArtifactMarkdownFresh,
} from "./artifact-markdown.js";

const n = artifactSchema.nodes;
const text = (value: string) => artifactSchema.text(value);
const p = (...content: Node[]) => n.paragraph.create(null, content);
const cell = (type: "table_header" | "table_cell", value: string) =>
  n[type].create(null, p(...(value === "" ? [] : [text(value)])));
const table = (header: string[], ...rows: string[][]) =>
  n.table.create(null, [
    n.table_row.create(
      null,
      header.map((value) => cell("table_header", value)),
    ),
    ...rows.map((row) =>
      n.table_row.create(
        null,
        row.map((value) => cell("table_cell", value)),
      ),
    ),
  ]);
const code = (params: string, body: string) =>
  n.code_block.create({ params }, body === "" ? [] : [text(body)]);
const chip = (source: string) => n.chip.create({ source });
const image = (src: string, alt: string) => n.image.create({ src, alt });

/** Every block the editor's menus, shortcuts, and paste can make. */
const BLOCKS: ReadonlyArray<readonly [string, () => Node]> = [
  ["paragraph", () => p(text("Plain words."))],
  [
    "paragraph with chips",
    () =>
      p(
        text("Due "),
        chip("{{date:2026-11-04}}"),
        text(" for "),
        chip("@[Ada Lovelace](user:usr_ada)"),
        text(" and "),
        chip("@[dx](agent)"),
      ),
  ],
  [
    "image",
    () =>
      p(
        image(
          "/v1/threads/thr_1/storage/tsf_1/chart.png",
          "A chart of the week",
        ),
      ),
  ],
  [
    "image with Markdown in its alt text",
    () =>
      p(
        image(
          "/v1/threads/thr_1/storage/tsf_2/a%20b.png",
          "Q3 [draft] *v2* `x` \\ done",
        ),
      ),
  ],
  ["heading", () => n.heading.create({ level: 2 }, text("Plan"))],
  ["table", () => table(["Name", "State"], ["Editor", "Done"])],
  ["table with empty header", () => table(["", "", ""], ["", "", ""])],
  ["table with empty cells", () => table(["A", ""], ["", "b"], ["", ""])],
  [
    "table with a chip",
    () =>
      n.table.create(null, [
        n.table_row.create(null, [cell("table_header", "When")]),
        n.table_row.create(
          null,
          n.table_cell.create(
            null,
            p(chip("{{dropdown:Todo|*Doing:blue|Done:green}}")),
          ),
        ),
      ]),
  ],
  ["code", () => code("ts", "const done = true;")],
  ["empty code", () => code("", "")],
  [
    "dx-view",
    () => code("dx-view", '<html><body><h1 id="v">Chart</h1></body></html>'),
  ],
  ["divider", () => n.horizontal_rule.create()],
  ["quote", () => n.blockquote.create(null, p(text("Quoted.")))],
  [
    "bulleted list",
    () => n.bullet_list.create(null, n.list_item.create(null, p(text("One")))),
  ],
  [
    "numbered list",
    () =>
      n.ordered_list.create(null, n.list_item.create(null, p(text("First")))),
  ],
  [
    "checklist",
    () =>
      n.bullet_list.create(
        null,
        n.list_item.create({ checked: false }, p(text("To do"))),
      ),
  ],
];

type Container = (inner: Node[]) => Node;

/** Where a block can sit, with the item's own text before it. */
const CONTAINERS: ReadonlyArray<readonly [string, Container]> = [
  ["top level", (inner) => n.doc.create(null, [p(text("Before.")), ...inner])],
  [
    "bulleted item",
    (inner) =>
      n.doc.create(
        null,
        n.bullet_list.create(
          null,
          n.list_item.create(null, [p(text("Item")), ...inner]),
        ),
      ),
  ],
  [
    "numbered item",
    (inner) =>
      n.doc.create(
        null,
        n.ordered_list.create(
          null,
          n.list_item.create(null, [p(text("Item")), ...inner]),
        ),
      ),
  ],
  [
    "ticked checklist item with a mention",
    (inner) =>
      n.doc.create(
        null,
        n.bullet_list.create(null, [
          n.list_item.create({ checked: false }, p(text("Write notes"))),
          n.list_item.create({ checked: true }, [
            p(chip("@[dx](agent)"), text(" Approve publishing")),
            ...inner,
          ]),
        ]),
      ),
  ],
  [
    "checklist item with an empty first line",
    (inner) =>
      n.doc.create(
        null,
        n.bullet_list.create(
          null,
          n.list_item.create({ checked: false }, [p(), ...inner]),
        ),
      ),
  ],
  [
    "quote",
    (inner) =>
      n.doc.create(
        null,
        n.blockquote.create(null, [p(text("Said.")), ...inner]),
      ),
  ],
  [
    "item in a nested list",
    (inner) =>
      n.doc.create(
        null,
        n.bullet_list.create(
          null,
          n.list_item.create(null, [
            p(text("Outer")),
            n.ordered_list.create(
              null,
              n.list_item.create(null, [p(text("Inner")), ...inner]),
            ),
          ]),
        ),
      ),
  ],
  [
    "quote in a list item",
    (inner) =>
      n.doc.create(
        null,
        n.bullet_list.create(
          null,
          n.list_item.create(null, [
            p(text("Item")),
            n.blockquote.create(null, [p(text("Said.")), ...inner]),
          ]),
        ),
      ),
  ],
];

/** A block between two paragraphs, and then the same block after an empty line. */
const ARRANGEMENTS: ReadonlyArray<readonly [string, (block: Node) => Node[]]> =
  [
    ["alone", (block) => [block]],
    ["followed by text", (block) => [block, p(text("After."))]],
    ["after an empty line", (block) => [p(), block]],
  ];

const cases = CONTAINERS.flatMap(([where, contain]) =>
  BLOCKS.flatMap(([what, make]) =>
    ARRANGEMENTS.map(
      ([how, arrange]) =>
        [`${what} ${how} in ${where}`, contain(arrange(make()))] as const,
    ),
  ),
);

const describeDoc = (doc: Node) => JSON.stringify(doc.toJSON());

/** `doc` without the empty lines Markdown cannot hold. */
const withoutEmptyLines = (node: Node): Node => {
  if (node.isTextblock || node.isLeaf || node.type.name === "table")
    return node;
  const children: Node[] = [];
  node.forEach((child, _offset, index) => {
    const required = node.type.name === "list_item" && index === 0;
    if (child.type.name === "paragraph" && child.childCount === 0 && !required)
      return;
    children.push(withoutEmptyLines(child));
  });
  return node.type.createAndFill(node.attrs, children) ?? node;
};

const same = (back: Node, doc: Node) =>
  sameArtifactContent(withoutEmptyLines(back), withoutEmptyLines(doc));

describe("every document the editor can make reads back the same", () => {
  it.each(cases)("%s (written afresh)", (_name, doc) => {
    const markdown = serializeArtifactMarkdownFresh(doc);
    const back = parseArtifactMarkdown(markdown);
    expect(same(back, doc), `${markdown}\n---\n${describeDoc(back)}`).toBe(
      true,
    );
  });

  it.each(BLOCKS)(
    "%s added after an untouched last block (saved as an edit)",
    (_name, make) => {
      const codec = createArtifactMarkdownCodec();
      const parsed = codec.parse("Intro\n");
      const edited = parsed.copy(parsed.content.append(Fragment.from(make())));
      const markdown = codec.serialize(edited);
      const back = parseArtifactMarkdown(markdown);
      expect(same(back, edited), `${markdown}\n---\n${describeDoc(back)}`).toBe(
        true,
      );
    },
  );

  it("keeps a pasted image whose address has a space an image", () => {
    const doc = n.doc.create(
      null,
      p(image("https://example.com/a b<c>.png", "x")),
    );
    const back = parseArtifactMarkdown(serializeArtifactMarkdownFresh(doc));
    const src = back.firstChild?.firstChild?.attrs.src;
    expect(back.firstChild?.firstChild?.type.name).toBe("image");
    expect(decodeURI(String(src))).toBe("https://example.com/a b<c>.png");
  });

  it.each(cases)("%s (saved as an edit)", (_name, doc) => {
    const codec = createArtifactMarkdownCodec();
    // The editor holds a parsed document and replaces its content.
    const parsed = codec.parse("Before.\n\n- Item\n\n> Said.\n");
    const edited = parsed.type.create(parsed.attrs, doc.content);
    const markdown = codec.serialize(edited);
    const back = parseArtifactMarkdown(markdown);
    expect(same(back, edited), `${markdown}\n---\n${describeDoc(back)}`).toBe(
      true,
    );
    // And a second save of the read-back document writes the same bytes.
    const again = createArtifactMarkdownCodec();
    expect(again.serialize(again.parse(markdown))).toBe(markdown);
  });
});
