import { describe, expect, it } from "vitest";
import {
  parseTranscriptPatch,
  transcriptEditSource,
} from "./transcript-code-preview-model.js";

describe("transcriptEditSource", () => {
  it("supports the exact replacement and creation tools", () => {
    expect(
      transcriptEditSource("edit_file", {
        path: "/a",
        old_str: "old",
        new_str: "new",
      }),
    ).toEqual({ path: "/a", before: "old", after: "new" });
    expect(
      transcriptEditSource("create_file", { path: "/a", content: "new" }),
    ).toEqual({ path: "/a", before: "", after: "new" });
  });
  it("parses fenced result diffs without the trailing line range", () => {
    expect(
      parseTranscriptPatch(
        "```diff\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n```\n\n[1, 1]",
        "/a",
      ),
    ).toHaveLength(1);
  });
  it("derives the replaced region from a Flue edit call", () => {
    expect(
      transcriptEditSource("edit", {
        path: "src/app.ts",
        oldText: "a",
        newText: "b",
      }),
    ).toEqual({ path: "src/app.ts", before: "a", after: "b" });
  });

  it("treats a write as an all-new file", () => {
    expect(
      transcriptEditSource("write", { path: "new.ts", content: "x" }),
    ).toEqual({ path: "new.ts", before: "", after: "x" });
  });

  it.each([
    ["edit", { path: "a.ts", oldText: "a" }],
    ["edit", { oldText: "a", newText: "b" }],
    ["bash", { command: "sed -i s/a/b/ a.ts" }],
    ["edit", "not an object"],
  ])("returns nothing for %s input without a usable edit", (name, input) =>
    expect(transcriptEditSource(name, input)).toBeUndefined(),
  );
});
