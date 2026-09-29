import { describe, expect, it } from "vitest";
import { transcriptEditSource } from "./transcript-code-preview-model.js";

describe("transcriptEditSource", () => {
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
