import { describe, expect, it } from "vitest";
import {
  parseShellResult,
  shellCommandOperations,
} from "./shell-command-operation.js";
import { categoryForTool } from "./transcript-activity-projection.js";

describe("shell command operations", () => {
  it.each([
    ["create_file", "edit"],
    ["shell_command_status", "check"],
    ["shell_command_kill", "check"],
  ])("categorizes %s before generic heuristics", (name, category) =>
    expect(categoryForTool(name, {})).toBe(category),
  );
  it.each([
    ["cat a.ts", [{ kind: "read", path: "a.ts" }]],
    [
      "cat -n a.ts b.ts",
      [
        { kind: "read", path: "a.ts" },
        { kind: "read", path: "b.ts" },
      ],
    ],
    ["sed -n '2,9p' a.ts", [{ kind: "read", path: "a.ts", range: "L2-9" }]],
    ["sed -n '2p' a.ts", [{ kind: "read", path: "a.ts", range: "L2-2" }]],
    ["head -n 4 a.ts", [{ kind: "read", path: "a.ts", range: "L1-4" }]],
    [
      "rg -n -g '*.ts' -t ts needle src",
      [{ kind: "search", pattern: "needle", path: "src" }],
    ],
    ["rg -e 'a b' src", [{ kind: "search", pattern: "a b", path: "src" }]],
    [
      "git grep needle src",
      [{ kind: "search", pattern: "needle", path: "src" }],
    ],
    ["rg --files src", [{ kind: "list", path: "src" }]],
    [
      "rg needle src | head -n 5",
      [{ kind: "search", pattern: "needle", path: "src" }],
    ],
    [
      "cat a; cat b && cat c",
      [
        { kind: "read", path: "a" },
        { kind: "read", path: "b" },
        { kind: "read", path: "c" },
      ],
    ],
    ['cat "a b"', [{ kind: "read", path: "a b" }]],
    ["cat a\\ b", [{ kind: "read", path: "a b" }]],
    [
      "cat a\ncat b || cat c",
      [
        { kind: "read", path: "a" },
        { kind: "read", path: "b" },
        { kind: "read", path: "c" },
      ],
    ],
  ])("classifies %s", (command, expected) => {
    expect(shellCommandOperations(command as string)).toEqual(expected);
    expect(categoryForTool("shell_command", { command })).toBe("explore");
  });
  it.each([
    "cat $(pwd)",
    "cat a > b",
    "cat <<EOF\na\nEOF",
    "cd x && rg y",
    "sed -i 's/a/b/' a",
    "cat a &",
    "cat `pwd`",
    "cat a | unknown",
    "cat a &&",
    "find . -delete",
    "find . -exec echo x \\;",
    "rg --pre preprocess x src",
    "cat a | sort -o b",
    "cat 'unterminated",
  ])("keeps %s as command", (command) => {
    expect(shellCommandOperations(command)).toBeUndefined();
    expect(categoryForTool("shell_command", { command })).toBe("command");
  });
});
describe("shell results", () => {
  it("unwraps output and exit status", () =>
    expect(
      parseShellResult(
        "<output>hello\n<output>x</output></output>\n<exitCode>2</exitCode>",
      ),
    ).toEqual({ output: "hello\n<output>x</output>", exitCode: 2 }));
  it("unwraps stopped process", () =>
    expect(
      parseShellResult(
        "<output>done</output>\n<exitCode>0</exitCode>\n<running>false</running>\n<pid>42</pid>",
      ),
    ).toEqual({ output: "done", exitCode: 0, running: false, pid: 42 }));
  it("preserves unknown output", () =>
    expect(parseShellResult("plain text")).toEqual({ output: "plain text" }));
});
