import { describe, expect, it } from "vitest";
import { documentExcerpt } from "./artifact-embed-links.js";

const texts = (markdown: string) =>
  documentExcerpt(markdown).map((line) => line.text);

describe("an embedded document's excerpt", () => {
  it("reads the opening lines as plain text", () => {
    expect(
      texts(
        [
          "# Launch plan",
          "",
          "- [ ] Ship [the docs](https://example.com/docs) ![chart](/c.png)",
          "> Owner: @[Ada](user:usr_1), {{project:prj_1|Website}}",
          "```",
          "| a | b |",
          "1. Status {{dropdown:Todo|*Doing:blue}} on {{date#due:2026-11-26}}",
          "**Bold** and `code`",
          "Line six",
          "Line seven",
        ].join("\n"),
      ),
    ).toEqual([
      "Launch plan",
      "Ship the docs",
      "Owner: @Ada, Website",
      "Status Todo on 2026-11-26",
      "Bold and code",
      "Line six",
    ]);
  });

  // Issue #2588: anyone who can write an artifact chose what its embed
  // reads, and these took seconds to minutes on a reader's main thread.
  it.each([
    ["an unclosed chip", `{{a:${"x".repeat(2_000_000)}`],
    ["chips opened over and over", "{{a:".repeat(500_000)],
    ["project chips opened over and over", "{{project:".repeat(200_000)],
    ["brackets opened over and over", "[".repeat(2_000_000)],
    ["links opened over and over", "[](".repeat(700_000)],
    ["images opened over and over", "![".repeat(1_000_000)],
    // Lines the excerpt skips, so it reads every one.
    ["skipped lines", `|${"{{a:".repeat(100)}\n`.repeat(4_900)],
  ])("reads %s, 2 MB of it, at once", (_name, markdown) => {
    const start = performance.now();
    documentExcerpt(markdown);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
