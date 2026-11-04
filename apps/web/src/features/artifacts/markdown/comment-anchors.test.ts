/**
 * Between a selection in the editor and a comment's anchor in the Markdown.
 * The API places a comment on `quote` (text found in the current Markdown,
 * the occurrence nearest `near`), and reports `anchor` as UTF-16 offsets in
 * the Markdown; the editor works in document positions.
 *
 * Ways it can fail, each covered below:
 *  1. The quote sent is not in the Markdown (a selection across formatting
 *     or escapes), so the server refuses it.
 *  2. A repeated quote is placed on, or shown at, the wrong occurrence.
 *  3. A selection across blocks yields a quote no block holds.
 *  4. An anchor is shown at the wrong place once the editor has edits the
 *     server has not seen yet.
 *  5. A chip inside the quote breaks matching.
 *  6. An empty or blank selection, or one past the quote limit, is sent.
 */
import type { Node } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { createArtifactMarkdownCodec } from "./artifact-markdown.js";
import {
  anchorRange,
  markdownOffset,
  quoteForSelection,
} from "./comment-anchors.js";

/** Which occurrence of `quote` in `markdown` is nearest `near`. */
const nearestOccurrence = (markdown: string, quote: string, near: number) => {
  const found = [...markdown.matchAll(new RegExp(quote, "g"))].map(
    (m) => m.index ?? 0,
  );
  let best = 0;
  found.forEach((index, at) => {
    if (Math.abs(index - near) < Math.abs((found[best] ?? 0) - near)) best = at;
  });
  return best;
};

/** The document for `markdown`, and where a position falls in that Markdown. */
const open = (markdown: string) => {
  const codec = createArtifactMarkdownCodec();
  const doc = codec.parse(markdown);
  return {
    doc,
    offsetOf: (pos: number) => markdownOffset(codec, doc, pos),
  };
};

/** The document positions of the `index`-th occurrence of `text`. */
const find = (doc: Node, text: string, index = 0) => {
  const found: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    let at = (node.text ?? "").indexOf(text);
    while (at !== -1) {
      found.push({ from: pos + at, to: pos + at + text.length });
      at = (node.text ?? "").indexOf(text, at + 1);
    }
    return false;
  });
  const range = found[index];
  if (range === undefined) throw new Error(`no ${text} #${index}`);
  return range;
};

const MARKDOWN = `# Plan

The plan is **simple** and the plan works.

The plan again, with {{date:2026-11-03}} inside.

| A | B |
| --- | --- |
| the plan | x |
`;

describe("quotes for a selection", () => {
  const { doc, offsetOf } = open(MARKDOWN);

  it("quotes plain text, near its own occurrence", () => {
    const { from, to } = find(doc, "the plan works");
    const result = quoteForSelection(doc, from, to, MARKDOWN, offsetOf);
    expect(result?.quote).toBe("the plan works");
    expect(
      nearestOccurrence(MARKDOWN, "the plan works", result?.near ?? 0),
    ).toBe(0);
  });

  it("places a repeated quote on the occurrence selected", () => {
    const second = find(doc, "plan", 2);
    const result = quoteForSelection(
      doc,
      second.from,
      second.to,
      MARKDOWN,
      offsetOf,
    );
    expect(result?.quote).toBe("plan");
    expect(nearestOccurrence(MARKDOWN, "plan", result?.near ?? 0)).toBe(2);
  });

  it("quotes the longest piece found in the Markdown across formatting", () => {
    const start = find(doc, "plan is ").from;
    const end = find(doc, " and the plan").to;
    expect(quoteForSelection(doc, start, end, MARKDOWN, offsetOf)?.quote).toBe(
      " and the plan",
    );
  });

  it("keeps a chip inside the quote as its source", () => {
    const start = find(doc, "with ").from;
    const end = find(doc, " inside").to;
    expect(quoteForSelection(doc, start, end, MARKDOWN, offsetOf)?.quote).toBe(
      "with {{date:2026-11-03}} inside",
    );
  });

  it("places a quote the Markdown also holds in a link's address on the visible text", () => {
    const markdown = "See [docs](https://x.dev/docs).\n\nRead the docs.\n";
    const linked = open(markdown);
    const second = find(linked.doc, "docs", 1);
    const near = quoteForSelection(
      linked.doc,
      second.from,
      second.to,
      markdown,
      linked.offsetOf,
    )?.near;
    const visible = markdown.lastIndexOf("docs");
    const address = markdown.indexOf("/docs") + 1;
    expect(Math.abs((near ?? 0) - visible)).toBeLessThan(
      Math.abs((near ?? 0) - address),
    );
  });

  it("stays in the block the selection starts in", () => {
    const start = find(doc, "works").from;
    const end = find(doc, "again").to;
    expect(quoteForSelection(doc, start, end, MARKDOWN, offsetOf)?.quote).toBe(
      "works.",
    );
  });

  it("sends nothing for an empty, blank, or too long selection", () => {
    const at = find(doc, "simple").from;
    expect(quoteForSelection(doc, at, at, MARKDOWN, offsetOf)).toBeUndefined();
    const space = find(doc, " and").from;
    expect(
      quoteForSelection(doc, space, space + 1, MARKDOWN, offsetOf),
    ).toBeUndefined();
    const long = `${"word ".repeat(300)}\n`;
    const longOpen = open(long);
    expect(
      quoteForSelection(
        longOpen.doc,
        1,
        longOpen.doc.content.size - 1,
        long,
        longOpen.offsetOf,
      )?.quote.length,
    ).toBeLessThanOrEqual(1_000);
  });
});

describe("anchors in the editor", () => {
  it("shows an anchor at the occurrence it names", () => {
    const { doc, offsetOf } = open(MARKDOWN);
    const occurrences = [...MARKDOWN.matchAll(/the plan/g)].map(
      (m) => m.index ?? 0,
    );
    const second = occurrences[1] ?? 0;
    expect(
      anchorRange(
        doc,
        MARKDOWN,
        {
          quote: "the plan",
          start: second,
          end: second + "the plan".length,
        },
        offsetOf,
      ),
    ).toEqual(find(doc, "the plan", 1));
  });

  it("finds its text after unsaved edits elsewhere", () => {
    const edited = MARKDOWN.replace(
      "# Plan",
      "# Plan, renamed\n\nA new block.",
    );
    // The editor holds edits the server's anchor has not seen.
    const { doc, offsetOf } = open(edited);
    const start = MARKDOWN.indexOf("works");
    expect(
      anchorRange(
        doc,
        MARKDOWN,
        { quote: "works", start, end: start + 5 },
        offsetOf,
      ),
    ).toEqual(find(doc, "works"));
  });

  it("covers a chip inside the quote", () => {
    const { doc, offsetOf } = open(MARKDOWN);
    const quote = "with {{date:2026-11-03}} inside";
    const start = MARKDOWN.indexOf(quote);
    const range = anchorRange(
      doc,
      MARKDOWN,
      {
        quote,
        start,
        end: start + quote.length,
      },
      offsetOf,
    );
    expect(range?.from).toBe(find(doc, "with ").from);
    expect(range?.to).toBe(find(doc, " inside").to);
  });

  it("shows a quote the Markdown also holds in a link's address on the visible text", () => {
    const markdown = "See [docs](https://x.dev/docs).\n\nRead the docs.\n";
    const linked = open(markdown);
    const start = markdown.lastIndexOf("docs");
    expect(
      anchorRange(
        linked.doc,
        markdown,
        { quote: "docs", start, end: start + 4 },
        linked.offsetOf,
      ),
    ).toEqual(find(linked.doc, "docs", 1));
  });

  it("shows nothing for text the document no longer holds", () => {
    const { doc, offsetOf } = open(MARKDOWN.replace("simple", "plain"));
    const start = MARKDOWN.indexOf("simple");
    expect(
      anchorRange(
        doc,
        MARKDOWN,
        { quote: "simple", start, end: start + 6 },
        offsetOf,
      ),
    ).toBeUndefined();
  });
});
