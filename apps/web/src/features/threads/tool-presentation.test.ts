import { describe, expect, it } from "vitest";
import { presentTool } from "./tool-presentation.js";

describe("presentTool", () => {
  it.each(["shell_command_status", "shell_command_kill"])(
    "shows the process for %s",
    (name) => {
      expect(presentTool(name, { pid: 42 }, false).detail).toBe("pid 42");
    },
  );
  it.each([
    ["shell_command", { command: "cat a.ts b.ts" }, "Read a.ts, b.ts"],
    ["tool_search", { query: "" }, "Listed tools"],
    ["shell_command", { command: "pwd", workdir: "/workspace" }, "Ran command"],
    ["search_files", { query: "Transcript" }, "Searched"],
    ["read_file", { path: "src/a.ts" }, "Read a.ts"],
    ["custom_tool", {}, "Custom Tool"],
  ])("presents %s provider-neutrally", (name, input, title) => {
    expect(presentTool(name, input, false).title).toBe(title);
  });
});
