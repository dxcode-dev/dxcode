import { describe, expect, it } from "vitest";
import { presentTool } from "./tool-presentation.js";

describe("presentTool", () => {
  it.each([
    ["shell_command", { command: "cat a.ts" }, "Reading a.ts"],
    ["shell_command", { command: "rg x src" }, "Searching"],
    ["shell_command", { command: "ls src" }, "Listing"],
    ["create_file", { path: "a.ts" }, "Creating a.ts"],
    ["code_exec", {}, "Executing code"],
    ["web_search", {}, "Searching the web"],
    ["read_web_page", {}, "Reading web page"],
  ])("presents running %s", (name, input, title) =>
    expect(presentTool(name, input, true).title).toBe(title),
  );
  it.each(["shell_command_status", "shell_command_kill"])(
    "shows the process for %s",
    (name) => {
      expect(presentTool(name, { pid: 42 }, false).detail).toBe("pid 42");
    },
  );
  it.each([
    ["create_file", { path: "/a.ts", content: "x" }, "Created a.ts"],
    ["shell_command", { command: "cat a.ts b.ts" }, "Read a.ts, b.ts"],
    ["web_search", { objective: "docs" }, "Searched the web"],
    ["read_web_page", { url: "https://example.com" }, "Read web page"],
    ["tool_search", { query: "" }, "Listed tools"],
    ["code_exec", { code: "text(1)" }, "Executed code"],
    ["shell_command", { command: "pwd", workdir: "/workspace" }, "Ran command"],
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
