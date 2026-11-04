/**
 * Chips: `{{date:…}}`, `{{time:…}}`, `{{dropdown:…}}`, `{{toggle:…}}`, and
 * mentions `@[Name](user:ID)` / `@[dx](agent)`, each one inline atom whose
 * Markdown is its source.
 *
 * Ways it can fail, each covered below:
 *  1. Text that only looks like a chip (in code, malformed, an unknown kind,
 *     an invalid date) becomes a chip, or a valid chip stays text.
 *  2. A chip's source is rewritten when the block around it changes.
 *  3. Changing one chip rewrites other text in the line.
 *  4. A dropdown's `|` inside a table cell splits the cell, or its `\|`
 *     escapes leak into the chip.
 *  5. Editing a chip's value writes Markdown that no longer parses back as
 *     that chip (a bad date, a label with `|` or `}}`, two selections).
 *  6. A toggle hides chips with no matching toggle, or tagged chips leak out
 *     from a toggle that is off.
 */
import { readFileSync } from "node:fs";
import type { Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  createArtifactMarkdownCodec,
  parseArtifactMarkdown,
} from "./artifact-markdown.js";
import {
  type Chip,
  chipSource,
  hiddenChipTags,
  parseChip,
  tryChipSource,
} from "./chips.js";

const fixture = readFileSync(
  new URL("./fixtures/chips.md", import.meta.url),
  "utf8",
);

const chipsIn = (doc: Node) => {
  const out: Array<{ source: string; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "chip") out.push({ source: node.attrs.source, pos });
  });
  return out;
};

describe("chip sources", () => {
  it.each<[string, Chip | undefined]>([
    ["{{date:2026-11-03}}", { kind: "date", date: "2026-11-03" }],
    [
      "{{date#trip:2026-11-03}}",
      { kind: "date", tag: "trip", date: "2026-11-03" },
    ],
    ["{{date:2026-13-40}}", undefined],
    ["{{date:2026-02-30}}", undefined],
    ["{{date:0002-11-03}}", undefined],
    ["{{date:0202-11-03}}", undefined],
    ["{{toggle:k|a}}}", undefined],
    ["{{date:}}", undefined],
    [
      "{{time:2026-11-03T12:00:00Z}}",
      { kind: "time", instant: "2026-11-03T12:00:00Z" },
    ],
    ["{{time:yesterday}}", undefined],
    [
      "{{dropdown:Todo|*Doing:blue|Done:green}}",
      {
        kind: "dropdown",
        options: [
          { label: "Todo", selected: false },
          { label: "Doing", color: "blue", selected: true },
          { label: "Done", color: "green", selected: false },
        ],
      },
    ],
    ["{{dropdown:*A|*B}}", undefined],
    ["{{dropdown:A|*A}}", undefined],
    ["{{dropdown:A:pink}}", undefined],
    ["{{dropdown:}}", undefined],
    [
      "{{toggle:times|Show times}}",
      { kind: "toggle", key: "times", label: "Show times" },
    ],
    ["{{toggle:bad key|Label}}", undefined],
    ["{{nope}}", undefined],
    ["{{nope:x}}", undefined],
    [
      "@[Ada Lovelace](user:usr_0123456789abcdef)",
      { kind: "mention", name: "Ada Lovelace", userId: "usr_0123456789abcdef" },
    ],
    ["@[dx](agent)", { kind: "agent", name: "dx" }],
    ["@[Name](https://example.com)", undefined],
  ])("reads %j", (source, chip) => {
    expect(parseChip(source)).toEqual(chip);
    if (chip !== undefined) expect(chipSource(chip)).toBe(source);
  });

  it("refuses values that would not read back as the same chip", () => {
    expect(() => chipSource({ kind: "date", date: "2026-02-30" })).toThrow();
    expect(() =>
      chipSource({
        kind: "dropdown",
        options: [{ label: "a|b", selected: true }],
      }),
    ).toThrow();
    expect(() =>
      chipSource({ kind: "toggle", key: "k", label: "Show }} here" }),
    ).toThrow();
  });
});

describe("chip pickers", () => {
  it.each<Chip>([
    { kind: "date", date: "0002-11-03" },
    { kind: "date", date: "20261-11-03" },
    { kind: "time", instant: "+020261-11-03T12:00:00Z" },
    { kind: "toggle", key: "k", label: "a}" },
    { kind: "toggle", key: "k", label: "a {{b" },
  ])("writes nothing for a value typed halfway: %j", (chip) => {
    expect(tryChipSource(chip)).toBeUndefined();
  });

  it("writes a complete value", () => {
    expect(tryChipSource({ kind: "date", date: "2026-12-25" })).toBe(
      "{{date:2026-12-25}}",
    );
  });
});

describe("chips in Markdown", () => {
  it("reads every chip in the fixture, and nothing that only looks like one", () => {
    const sources = chipsIn(parseArtifactMarkdown(fixture)).map(
      (chip) => chip.source,
    );
    expect(sources).toEqual([
      "{{date:2026-11-03}}",
      "{{time:2026-11-03T12:00:00Z}}",
      "{{dropdown:Todo|*Doing:blue|Done:green}}",
      "{{toggle:times|Show times}}",
      "{{time#times:2026-11-03T09:30:00Z}}",
      "{{time#times:2026-11-03T17:00:00Z}}",
      "@[Ada Lovelace](user:usr_0123456789abcdef)",
      "@[dx](agent)",
      "{{date:2026-01-01}}",
      "{{date:2026-12-31}}",
      "{{date:2026-02-02}}",
      "{{date:2026-11-04}}",
      "{{dropdown:Todo|*Doing:blue|Done:green}}",
      "{{date:2026-11-05}}",
      "@[Ada Lovelace](user:usr_0123456789abcdef)",
      "{{time:2026-11-05T08:00:00Z}}",
      "{{date:2026-11-06}}",
      "@[dx](agent)",
    ]);
  });

  it("changes one chip without rewriting the rest of its line", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(fixture);
    const dropdown = chipsIn(doc).find((chip) =>
      chip.source.startsWith("{{dropdown"),
    );
    if (dropdown === undefined) throw new Error("no dropdown");
    const output = codec.serialize(
      new Transform(doc).setNodeMarkup(dropdown.pos, null, {
        source: "{{dropdown:Todo|Doing:blue|*Done:green}}",
      }).doc,
    );
    expect(output).toBe(
      fixture.replace(
        "status {{dropdown:Todo|*Doing:blue|Done:green}}",
        "status {{dropdown:Todo|Doing:blue|*Done:green}}",
      ),
    );
  });

  it("keeps a changed dropdown in a table cell as one chip in one cell", () => {
    const codec = createArtifactMarkdownCodec();
    const doc = codec.parse(fixture);
    const inTable = chipsIn(doc).filter((chip) =>
      chip.source.startsWith("{{dropdown"),
    )[1];
    if (inTable === undefined) throw new Error("no table dropdown");
    const output = codec.serialize(
      new Transform(doc).setNodeMarkup(inTable.pos, null, {
        source: "{{dropdown:*Todo|Doing:blue|Done:green}}",
      }).doc,
    );
    expect(output).toContain(
      "| Editor | {{dropdown:*Todo\\|Doing:blue\\|Done:green}} | {{date:2026-11-05}} |",
    );
    const reparsed = chipsIn(parseArtifactMarkdown(output)).map(
      (chip) => chip.source,
    );
    expect(reparsed).toContain("{{dropdown:*Todo|Doing:blue|Done:green}}");
    expect(output).not.toContain(
      "{{dropdown:Todo|*Doing:blue|Done:green}} | {{date:2026-11-05}}",
    );
  });

  it("writes a new chip in a paragraph so it reads back as that chip", () => {
    const doc = artifactSchema.nodes.doc.create(null, [
      artifactSchema.nodes.paragraph.create(null, [
        artifactSchema.text("Due "),
        artifactSchema.nodes.chip.create({ source: "{{date:2026-11-09}}" }),
        artifactSchema.text(" for "),
        artifactSchema.nodes.chip.create({ source: "@[dx](agent)" }),
      ]),
    ]);
    const output = createArtifactMarkdownCodec().serialize(doc);
    expect(output).toBe("Due {{date:2026-11-09}} for @[dx](agent)\n");
    expect(
      chipsIn(parseArtifactMarkdown(output)).map((chip) => chip.source),
    ).toEqual(["{{date:2026-11-09}}", "@[dx](agent)"]);
  });
});

describe("toggles", () => {
  it("hides a toggle's tagged chips until it is on, and no others", () => {
    const sources = [
      "{{toggle:times|Show times}}",
      "{{time#times:2026-11-03T09:30:00Z}}",
      "{{date#trip:2026-11-03}}",
    ];
    expect([...hiddenChipTags(sources, new Set())]).toEqual(["times"]);
    expect([...hiddenChipTags(sources, new Set(["times"]))]).toEqual([]);
  });
});
