import { describe, expect, it } from "vitest";
import { presentTool } from "./tool-presentation.js";

describe("presentTool", () => {
  it.each([
    ["shell", { command: "pnpm test" }, "Ran command"],
    ["search_files", { query: "Transcript" }, "Searched"],
    ["read_file", { path: "src/a.ts" }, "Read a.ts"],
    ["edit_file", { path: "src/a.ts" }, "Edited a.ts"],
    ["write_file", { path: "src/a.ts" }, "Wrote a.ts"],
    ["load_skill", { name: "review" }, "Loaded skill"],
    ["custom_tool", {}, "Custom Tool"],
  ])("presents %s provider-neutrally", (name, input, title) => {
    expect(presentTool(name, input, false).title).toBe(title);
  });
});
