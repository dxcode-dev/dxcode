/**
 * Markdown is an artifact's stored format, so the editor's parse → edit →
 * serialize must never rewrite text a person did not touch.
 *
 * Ways it can fail, each covered below:
 *  1. An untouched document comes back with different bytes: bullets, emphasis
 *     markers, escapes, blank lines, setext headings, CRLF, tabs, a missing
 *     final newline, or leading blank lines are normalized.
 *  2. Text with no node of its own is dropped: reference definitions,
 *     front matter, HTML, chips, mentions, task markers.
 *  3. Editing one block rewrites another block or the blank lines between
 *     them.
 *  4. Ticking a checkbox rewrites the rest of the item (escape churn such as
 *     `snake_case` becoming `snake\_case`).
 *  5. A block the editor writes afresh parses back to different content:
 *     line-start `#`, `-`, `1.`, `>`, literal `*` and `_`, `|` in a table
 *     cell, a fence inside a code block.
 *  6. A `dx-view` fence is altered in its info string, fence, or body.
 *  7. A block inserted next to another merges with it (lazy continuation
 *     when the blank line between them is missing).
 *  8. Deleting a block takes reference definitions with it.
 *  9. A duplicated block is emitted once, or glued to its copy.
 * 10. An edited block in a CRLF document gets bare LF line endings.
 * 11. The three-way merge drops one side's change, drops a person's draft on
 *     an overlapping change, or flags the wrong blocks.
 * 12. A dropdown an agent wrote in a table cell without escaping its `|`
 *     splits across cells (#1865), an escaped one is escaped twice, or a
 *     dropdown outside a table changes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { Fragment, type Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  createArtifactMarkdownCodec,
  parseArtifactMarkdown,
  safeHref,
  sameArtifactContent,
  serializeArtifactMarkdownFresh,
  topLevelSources,
} from "./artifact-markdown.js";
import { mergeArtifactMarkdown } from "./artifact-merge.js";
import { itemAt } from "./item-at.js";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const fixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => ({
    name,
    source: readFileSync(new URL(name, fixtureDirectory), "utf8"),
  }));

const fixture = (name: string) => {
  const found = fixtures.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found.source;
};

/** A document position just inside the first textblock of top-level block `index`. */
const firstTextPosition = (doc: Node, index: number): number | undefined => {
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += doc.child(i).nodeSize;
  const block = doc.child(index);
  let found: number | undefined;
  block.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.isTextblock) {
      found = offset + 1 + pos + 1;
      return false;
    }
    return true;
  });
  if (found === undefined && block.isTextblock) found = offset + 1;
  return found;
};

/** The position of the list item whose text starts with `prefix`. */
const listItemPosition = (doc: Node, prefix: string): number => {
  let found: number | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (
      node.type.name === "list_item" &&
      node.firstChild?.textContent.startsWith(prefix)
    ) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found === undefined) throw new Error(`no list item ${prefix}`);
  return found;
};

describe("artifact Markdown round trip", () => {
  it("has a corpus covering every construct", () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual(
      expect.arrayContaining([
        "canonical.md",
        "checklists.md",
        "code.md",
        "crlf.md",
        "headings.md",
        "links.md",
        "lists.md",
        "quirks.md",
        "report.md",
        "tables.md",
      ]),
    );
  });

  for (const { name, source } of fixtures) {
    describe(name, () => {
      it("serializes an untouched document to the same bytes", () => {
        const codec = createArtifactMarkdownCodec();
        expect(codec.serialize(codec.parse(source))).toBe(source);
      });

      it("writes every block afresh to Markdown that parses to the same content", () => {
        const doc = parseArtifactMarkdown(source);
        const fresh = serializeArtifactMarkdownFresh(doc);
        const reparsed = parseArtifactMarkdown(fresh);
        expect(sameArtifactContent(reparsed, doc)).toBe(true);
      });

      it("rewrites only the block a person edited", () => {
        const sources = topLevelSources(source);
        for (let index = 0; index < sources.blocks.length; index += 1) {
          const codec = createArtifactMarkdownCodec();
          const doc = codec.parse(source);
          expect(doc.childCount).toBe(sources.blocks.length);
          const position = firstTextPosition(doc, index);
          if (position === undefined) continue;
          const edited = new Transform(doc).insert(
            position,
            artifactSchema.text("EDIT "),
          ).doc;
          const output = codec.serialize(edited);
          const before =
            sources.lead +
            sources.blocks
              .slice(0, index)
              .map((block) => block.source + block.gap)
              .join("");
          const after =
            itemAt(sources.blocks, index).gap +
            sources.blocks
              .slice(index + 1)
              .map((block) => block.source + block.gap)
              .join("");
          expect(output.startsWith(before), `${name} block ${index}`).toBe(
            true,
          );
          expect(output.endsWith(after), `${name} block ${index}`).toBe(true);
          const reparsed = parseArtifactMarkdown(output);
          expect(reparsed.child(index).textContent).toContain("EDIT");
          expect(reparsed.childCount).toBe(doc.childCount);
        }
      });
    });
  }
});

describe("artifact Markdown edits", () => {
  const checklist = fixture("checklists.md");

  it("ticks a checkbox by changing only its marker", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(checklist);
    const position = listItemPosition(doc, "Item with");
    const item = itemAt(
      [doc.nodeAt(position)].filter((node) => node !== null),
      0,
    );
    const ticked = codec.serialize(
      new Transform(doc).setNodeMarkup(position, null, {
        ...item.attrs,
        checked: true,
      }).doc,
    );
    expect(ticked).toBe(
      checklist.replace(
        "- [ ] Item with `code_span`",
        "- [x] Item with `code_span`",
      ),
    );
  });

  it("unticks a nested checkbox by changing only its marker", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(checklist);
    const position = listItemPosition(doc, "nested done");
    const item = itemAt(
      [doc.nodeAt(position)].filter((node) => node !== null),
      0,
    );
    const output = codec.serialize(
      new Transform(doc).setNodeMarkup(position, null, {
        ...item.attrs,
        checked: false,
      }).doc,
    );
    expect(output).toBe(
      checklist.replace("- [x] nested done", "- [ ] nested done"),
    );
  });

  it("rewrites only the list item a person edited", () => {
    const source = fixture("lists.md");
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    let position: number | undefined;
    doc.descendants((node, pos) => {
      if (position === undefined && node.isText && node.text === "nested b")
        position = pos + node.nodeSize;
      return position === undefined;
    });
    const output = codec.serialize(
      new Transform(doc).insert(position ?? 0, artifactSchema.text(" (edited)"))
        .doc,
    );
    expect(output).toBe(source.replace("nested b", "nested b (edited)"));
  });

  it("adds a table row without rewriting the other rows or the delimiter", () => {
    const source = "| Part | Owner |\n|------|------:|\n| API  | step_1 |\n";
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const table = doc.child(0);
    const row = table.child(2 - 1);
    const added = doc.copy(
      Fragment.from(
        table.copy(
          table.content.addToEnd(
            row.type.create(null, [cellWith("Web"), cellWith("step_3")]),
          ),
        ),
      ),
    );
    expect(codec.serialize(added)).toBe(`${source}| Web | step_3 |\n`);
  });

  it("keeps a new paragraph between two blocks apart from both", () => {
    const source = "# Title\nBody line.\n";
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const inserted = doc.copy(
      doc.content
        .addToEnd(paragraph("tail"))
        .replaceChild(1, paragraph("middle")),
    );
    const output = codec.serialize(
      doc.copy(
        doc.content
          .cut(0, doc.child(0).nodeSize)
          .addToEnd(paragraph("- not a list"))
          .addToEnd(doc.child(1)),
      ),
    );
    expect(output).toBe("# Title\n\n\\- not a list\n\nBody line.\n");
    expect(parseArtifactMarkdown(output).childCount).toBe(3);
    expect(codec.serialize(inserted)).toContain("middle\n\ntail");
  });

  it("keeps reference definitions when the block before them is deleted", () => {
    const source = fixture("links.md");
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const index = indexOfBlock(doc, "Reference");
    const output = codec.serialize(doc.copy(removeChild(doc.content, index)));
    expect(output).toContain(
      '[ref]: https://example.com/reference\n[collapsed]: https://example.com/collapsed "Collapsed"',
    );
    expect(output).not.toContain("Reference [style link]");
  });

  it("emits a duplicated block twice, apart", () => {
    const source = "First.\n\nSecond.\n";
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const output = codec.serialize(
      doc.copy(doc.content.addToStart(doc.child(0))),
    );
    expect(output).toBe("First.\n\nFirst.\n\nSecond.\n");
  });

  it("writes an edited block with the document's CRLF line endings", () => {
    const source = fixture("crlf.md");
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const output = codec.serialize(
      doc.copy(
        doc.content.replaceChild(0, paragraph("Changed one\nchanged two")),
      ),
    );
    expect(output).toBe(
      "Changed one\r\nchanged two\r\n\r\n- item\r\n- item two\r\n",
    );
  });

  it("keeps a dx-view fence verbatim when the block next to it changes", () => {
    const source = fixture("code.md");
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(source);
    const output = codec.serialize(
      doc.copy(doc.content.replaceChild(0, paragraph("Changed."))),
    );
    const view = source.slice(
      source.indexOf("```dx-view"),
      source.indexOf("```\n\n    indented") + 3,
    );
    expect(output).toContain(view);
  });

  it.each([
    ["# not a heading"],
    ["1. not a list"],
    ["- not a list"],
    ["+ not a list"],
    ["> not a quote"],
    ["*literal stars*"],
    ["_literal underscores_"],
    ["snake_case and 2*3*4"],
    ["[not a link](x)"],
    ["```not a fence"],
    ["a \\ backslash"],
    ["---"],
    ["<https://not-an-autolink>"],
    ["{{date:2026-11-03}} and @[dx](agent)"],
  ])("writes a new paragraph %j so it parses back as the same text", (text) => {
    const codec = createArtifactMarkdownCodec();
    const doc = artifactSchema.nodes.doc.create(null, [paragraph(text)]);
    const output = codec.serialize(doc);
    const reparsed = parseArtifactMarkdown(output);
    expect(reparsed.childCount).toBe(1);
    expect(reparsed.child(0).type.name).toBe("paragraph");
    expect(reparsed.child(0).textContent).toBe(text);
  });

  it("does not escape plain text it does not need to", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = artifactSchema.nodes.doc.create(null, [
      paragraph("snake_case_name and file_name.md cost 2 * 3"),
    ]);
    expect(codec.serialize(doc)).toBe(
      "snake_case_name and file_name.md cost 2 * 3\n",
    );
  });

  it("writes a table cell with a pipe so it stays one cell", () => {
    const { table, table_row, table_header, table_cell } = artifactSchema.nodes;
    const doc = artifactSchema.nodes.doc.create(null, [
      table.create(null, [
        table_row.create(null, [
          table_header.create(null, paragraph("A")),
          table_header.create(null, paragraph("B")),
        ]),
        table_row.create(null, [
          table_cell.create(null, paragraph("x | y")),
          table_cell.create(null, paragraph("")),
        ]),
      ]),
    ]);
    const output = createArtifactMarkdownCodec().serialize(doc);
    expect(output).toBe("| A | B |\n| --- | --- |\n| x \\| y |  |\n");
    expect(sameArtifactContent(parseArtifactMarkdown(output), doc)).toBe(true);
  });

  it("reads a dropdown written in a table cell with bare | as one chip, keeping the bytes", () => {
    const source = [
      "| Task | State |",
      "| --- | --- |",
      "| Editor | {{dropdown:Todo|*Doing:blue|Done:green}} |",
      "| Docs | {{dropdown:Todo\\|*Doing:blue}} |",
      "",
      "Outside {{dropdown:A|*B}}.",
      "",
    ].join("\n");
    const doc = parseArtifactMarkdown(source);
    const table = doc.child(0);
    expect(table.type.name).toBe("table");
    const cells = (row: number) =>
      Array.from({ length: table.child(row).childCount }, (_, at) => {
        const cell = table.child(row).child(at);
        const chips: string[] = [];
        cell.descendants((node) => {
          if (node.type.name === "chip") chips.push(String(node.attrs.source));
        });
        return chips.length > 0 ? chips : cell.textContent;
      });
    expect(cells(1)).toEqual([
      "Editor",
      ["{{dropdown:Todo|*Doing:blue|Done:green}}"],
    ]);
    expect(cells(2)).toEqual(["Docs", ["{{dropdown:Todo|*Doing:blue}}"]]);
    const outside: string[] = [];
    doc.child(1).descendants((node) => {
      if (node.type.name === "chip") outside.push(String(node.attrs.source));
    });
    expect(outside).toEqual(["{{dropdown:A|*B}}"]);
    const codec = createArtifactMarkdownCodec();
    expect(codec.serialize(codec.parse(source))).toBe(source);
  });

  it("fences code that contains a fence with a longer fence", () => {
    const doc = artifactSchema.nodes.doc.create(null, [
      artifactSchema.nodes.code_block.create(
        { params: "md" },
        artifactSchema.text("```\ninner\n```"),
      ),
    ]);
    const output = createArtifactMarkdownCodec().serialize(doc);
    expect(output).toBe("````md\n```\ninner\n```\n````\n");
    expect(sameArtifactContent(parseArtifactMarkdown(output), doc)).toBe(true);
  });

  it("drops an empty paragraph instead of writing blank lines", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse("A\n\nB\n");
    const output = codec.serialize(
      doc.copy(
        doc.content
          .cut(0, doc.child(0).nodeSize)
          .addToEnd(paragraph(""))
          .addToEnd(doc.child(1)),
      ),
    );
    expect(output).toBe("A\n\nB\n");
  });
});

describe("artifact links", () => {
  it.each([
    ["https://example.com", true],
    ["mailto:a@example.com", true],
    ["user:usr_0123", true],
    ["agent", true],
    ["docs/plan.md", true],
    ["javascript:alert(1)", false],
    [" JavaScript:alert(1)", false],
    ["data:text/html,<b>x</b>", false],
    ["vbscript:x", false],
  ])("treats %j as safe to follow: %s", (href, safe) => {
    expect(safeHref(href)).toBe(safe);
  });
});

describe("artifact Markdown merge", () => {
  const base = "# Plan\n\nIntro.\n\n- [ ] one\n- [ ] two\n\nOutro.\n";

  it("returns the other side when one side is unchanged", () => {
    const theirs = base.replace("Outro.", "Outro, by the agent.");
    expect(mergeArtifactMarkdown({ base, mine: base, theirs })).toEqual({
      markdown: theirs,
      conflicts: [],
    });
    expect(mergeArtifactMarkdown({ base, mine: theirs, theirs: base })).toEqual(
      { markdown: theirs, conflicts: [] },
    );
  });

  it("keeps both sides' changes to different blocks", () => {
    const mine = base.replace("Intro.", "Intro, by a person.");
    const theirs = base
      .replace("Outro.", "Outro, by the agent.")
      .concat("\nAppended by the agent.\n");
    const result = mergeArtifactMarkdown({ base, mine, theirs });
    expect(result.conflicts).toEqual([]);
    expect(result.markdown).toBe(
      "# Plan\n\nIntro, by a person.\n\n- [ ] one\n- [ ] two\n\nOutro, by the agent.\n\nAppended by the agent.\n",
    );
  });

  it("keeps both sides' changes to adjacent blocks", () => {
    const mine = base.replace("# Plan", "# Plan (draft)");
    const theirs = base.replace("Intro.", "Intro, by the agent.");
    expect(mergeArtifactMarkdown({ base, mine, theirs })).toEqual({
      markdown:
        "# Plan (draft)\n\nIntro, by the agent.\n\n- [ ] one\n- [ ] two\n\nOutro.\n",
      conflicts: [],
    });
  });

  it("takes an identical change once", () => {
    const changed = base.replace("Intro.", "Same change.");
    expect(
      mergeArtifactMarkdown({ base, mine: changed, theirs: changed }),
    ).toEqual({ markdown: changed, conflicts: [] });
  });

  it("keeps both versions of a block both sides changed, and flags them", () => {
    const mine = base.replace("Intro.", "Intro, mine.");
    const theirs = base.replace("Intro.", "Intro, theirs.");
    const result = mergeArtifactMarkdown({ base, mine, theirs });
    expect(result.markdown).toBe(
      "# Plan\n\nIntro, theirs.\n\nIntro, mine.\n\n- [ ] one\n- [ ] two\n\nOutro.\n",
    );
    expect(result.conflicts).toEqual([1, 2]);
    const doc = parseArtifactMarkdown(result.markdown);
    expect(result.conflicts.map((i) => doc.child(i).textContent)).toEqual([
      "Intro, theirs.",
      "Intro, mine.",
    ]);
  });

  it("keeps the other side's edit to a block this side deleted", () => {
    const mine = base.replace("Intro.\n\n", "");
    const theirs = base.replace("Intro.", "Intro, edited by the agent.");
    const result = mergeArtifactMarkdown({ base, mine, theirs });
    expect(result.markdown).toContain("Intro, edited by the agent.");
    expect(result.conflicts).toEqual([1]);
  });

  it("keeps both blocks inserted at the same place", () => {
    const mine = base.replace("Outro.\n", "Outro.\n\nMine at end.\n");
    const theirs = base.replace("Outro.\n", "Outro.\n\nTheirs at end.\n");
    const result = mergeArtifactMarkdown({ base, mine, theirs });
    expect(result.markdown).toBe(`${base}\nTheirs at end.\n\nMine at end.\n`);
    expect(result.conflicts).toEqual([4, 5]);
  });

  it("merges ticks of different items in the same checklist", () => {
    const mine = base.replace("- [ ] one", "- [x] one");
    const theirs = base.replace("- [ ] two", "- [x] two");
    expect(mergeArtifactMarkdown({ base, mine, theirs })).toEqual({
      markdown: base
        .replace("- [ ] one", "- [x] one")
        .replace("- [ ] two", "- [x] two"),
      conflicts: [],
    });
  });

  it("keeps both versions of a list item both sides changed inside one list", () => {
    const mine = base.replace("- [ ] two", "- [ ] two, mine");
    const theirs = base.replace("- [ ] two", "- [ ] two, theirs");
    const result = mergeArtifactMarkdown({ base, mine, theirs });
    expect(result.markdown).toBe(
      base.replace("- [ ] two", "- [ ] two, theirs\n- [ ] two, mine"),
    );
    const doc = parseArtifactMarkdown(result.markdown);
    expect(doc.childCount).toBe(4);
    expect(result.conflicts).toEqual([2]);
    expect(itemAt([doc.child(2)], 0).type.name).toBe("bullet_list");
  });

  it("merges edits to different rows of one table", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n";
    expect(
      mergeArtifactMarkdown({
        base: table,
        mine: table.replace("| 1 | x |", "| 1 | mine |"),
        theirs: table.replace("| 2 | y |", "| 2 | theirs |"),
      }),
    ).toEqual({
      markdown: "| A | B |\n| --- | --- |\n| 1 | mine |\n| 2 | theirs |\n",
      conflicts: [],
    });
  });

  it("prefers this side on a conflict when asked, keeping the other side's other changes", () => {
    const mine = base.replace("Intro.", "Intro, mine.");
    const theirs = base
      .replace("Intro.", "Intro, theirs.")
      .replace("Outro.", "Outro, theirs.");
    expect(
      mergeArtifactMarkdown({ base, mine, theirs, prefer: "mine" }),
    ).toEqual({
      markdown: base
        .replace("Intro.", "Intro, mine.")
        .replace("Outro.", "Outro, theirs."),
      conflicts: [],
    });
  });

  it("flags only blocks that exist once the merge is parsed", () => {
    const cases = [
      ["- a\n- b\n\nP\n", "- a2\n- b\n\nP\n", "- a3\n- b\n\nP\n"],
      ["* a\n\nP\n", "* a\n* m\n\nP\n", "* a\n* t\n\nP\n"],
      ["1. a\n2. b\n", "1. a\n2. b mine\n", "1. a\n2. b theirs\n"],
    ] as const;
    for (const [original, mine, theirs] of cases) {
      const result = mergeArtifactMarkdown({ base: original, mine, theirs });
      const doc = parseArtifactMarkdown(result.markdown);
      expect(result.conflicts.length).toBeGreaterThan(0);
      for (const index of result.conflicts)
        expect(index).toBeLessThan(doc.childCount);
      expect(doc.child(itemAt(result.conflicts, 0)).type.name).not.toBe(
        "paragraph",
      );
    }
  });

  it("keeps blocks apart when a side's last block had no final newline", () => {
    const noFinal = "A\n\nB";
    const result = mergeArtifactMarkdown({
      base: noFinal,
      mine: "A changed\n\nB",
      theirs: "A\n\nB\n\nC",
    });
    expect(result.conflicts).toEqual([]);
    expect(parseArtifactMarkdown(result.markdown).childCount).toBe(3);
    expect(result.markdown).toBe("A changed\n\nB\n\nC");
  });
});

/** A table cell holding `text`, in its one paragraph. */
const cellWith = (text: string) =>
  artifactSchema.nodes.table_cell.create(null, paragraph(text));

const paragraph = (text: string) =>
  artifactSchema.nodes.paragraph.create(
    null,
    text === "" ? null : artifactSchema.text(text),
  );

const indexOfBlock = (doc: Node, prefix: string) => {
  for (let i = 0; i < doc.childCount; i += 1)
    if (doc.child(i).textContent.startsWith(prefix)) return i;
  throw new Error(`no block ${prefix}`);
};

const removeChild = (fragment: Fragment, index: number) => {
  const children: Node[] = [];
  fragment.forEach((child, _offset, i) => {
    if (i !== index) children.push(child);
  });
  return Fragment.from(children);
};
