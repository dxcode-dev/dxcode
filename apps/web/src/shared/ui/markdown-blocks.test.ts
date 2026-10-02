import { describe, expect, it } from "vitest";
import { settledMarkdownBlocks } from "./markdown-blocks.js";

describe("settledMarkdownBlocks", () => {
  it("round-trips the source and settles blocks at blank lines", () => {
    const text = "# Title\n\nFirst paragraph.\n\nSecond paragraph\nmore";
    const blocks = settledMarkdownBlocks(text);
    expect(blocks).toEqual([
      "# Title\n",
      "First paragraph.\n",
      "Second paragraph\nmore",
    ]);
    expect(blocks.join("\n")).toBe(text);
  });

  it("keeps fenced code, including its blank lines, in one block", () => {
    const text =
      "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter\n\n~~~\nx\n\n~~~\n";
    const blocks = settledMarkdownBlocks(text);
    expect(blocks).toEqual([
      "Intro\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n",
      "After\n",
      "~~~\nx\n\n~~~\n",
    ]);
    expect(blocks.join("\n")).toBe(text);
  });

  it("keeps an unclosed fence in the unsettled tail", () => {
    expect(
      settledMarkdownBlocks("Intro\n\n```py\nprint(1)\n\nprint(2)"),
    ).toEqual(["Intro\n", "```py\nprint(1)\n\nprint(2)"]);
  });

  it("keeps indented list continuations with their item", () => {
    const text = "1. Step one\n\n   Details\n\n2. Step two\n\nAfter\n";
    expect(settledMarkdownBlocks(text)).toEqual([
      "1. Step one\n\n   Details\n\n2. Step two\n",
      "After\n",
    ]);
  });

  it("keeps the items of a loose list in one document", () => {
    expect(
      settledMarkdownBlocks("1. first\n\n2. second\n\n3. third\n\nAfter\n"),
    ).toEqual(["1. first\n\n2. second\n\n3. third\n", "After\n"]);
    expect(settledMarkdownBlocks("Intro\n- a\n\n- b\n\n* c")).toEqual([
      "Intro\n- a\n\n- b\n\n* c",
    ]);
    // A paragraph before a list is a separate construct.
    expect(settledMarkdownBlocks("Intro\n\n- a\n\n- b")).toEqual([
      "Intro\n",
      "- a\n\n- b",
    ]);
    // An unfinished last line may still become a list marker ("1" -> "1. ").
    expect(settledMarkdownBlocks("1. first\n\n2")).toEqual(["1. first\n\n2"]);
    // A thematic break is not a list item.
    expect(settledMarkdownBlocks("- a\n\n---\n\nNext\n")).toEqual([
      "- a\n",
      "---\n",
      "Next\n",
    ]);
  });

  it("does not settle a trailing blank line before more text arrives", () => {
    expect(settledMarkdownBlocks("Paragraph\n\n")).toEqual(["Paragraph\n\n"]);
  });

  it("keeps settled blocks byte-identical as streamed text grows", () => {
    const full =
      "## Plan\n\nRead the code.\n\n```ts\nconst x = 1;\n\nexport { x };\n```\n\n- one\n- two\n\n1. loose\n\n2. list\n\nDone.";
    let previous: string[] = [];
    for (let end = 1; end <= full.length; end++) {
      const blocks = settledMarkdownBlocks(full.slice(0, end));
      expect(blocks.join("\n")).toBe(full.slice(0, end));
      // Every block except the tail must survive unchanged.
      for (let i = 0; i < previous.length - 1; i++)
        expect(blocks[i]).toBe(previous[i]);
      previous = blocks;
    }
  });
});
