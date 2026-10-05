import { describe, expect, it } from "vitest";
import type { WorkRow } from "./transcript-activity-projection.js";
import { activitySummary } from "./transcript-activity-summary.js";

const tool = (
  index: number,
  toolName: string,
  input: Record<string, unknown>,
): WorkRow =>
  ({
    kind: "settled-work",
    id: `row-${index}`,
    turnId: "turn-1",
    messageId: "message-1",
    partIndex: index,
    part: {
      type: "dynamic-tool",
      toolName,
      toolCallId: `call-${index}`,
      state: "output-available",
      input,
      output: "ok",
    },
  }) as unknown as WorkRow;

describe("activitySummary", () => {
  it("groups the new file and shell tools without losing process checks", () => {
    expect(
      activitySummary([
        tool(0, "create_file", { path: "/a", content: "a" }),
        tool(1, "edit_file", { path: "/b", old_str: "a", new_str: "b" }),
        tool(2, "shell_command", { command: "pwd", workdir: "/workspace" }),
        tool(3, "shell_command_status", { pid: 42 }),
        tool(4, "shell_command_kill", { pid: 42 }),
      ]),
    ).toBe(
      "Created 1 file, edited 1 file, ran 1 command, checked on 2 commands",
    );
  });
  it("counts shell operations and specialized tools", () => {
    expect(
      activitySummary([
        tool(0, "shell_command", {
          command: "cat a.ts b.ts; rg x src; ls src",
        }),
        tool(1, "shell_command", { command: "cat a.ts" }),
        tool(2, "shell_command", { command: "pwd" }),
        tool(3, "web_search", { objective: "docs" }),
        tool(4, "read_web_page", { url: "https://example.com" }),
        tool(5, "read_web_page", { url: "https://example.com" }),
        tool(6, "tool_search", { query: "tools" }),
        tool(7, "code_exec", { code: "text(1)" }),
      ]),
    ).toBe(
      "Read 2 files, searched 1 time, listed 1 directory, ran 1 command, searched the web 1 time, read 1 web page, searched tools 1 time, executed code 1 time",
    );
  });
  it("counts bash as commands and edit tools as edited files", () => {
    expect(
      activitySummary([
        tool(0, "bash", { command: "pnpm test" }),
        tool(1, "edit", { path: "a.ts", oldText: "a", newText: "b" }),
        tool(2, "bash", { command: "git status" }),
        tool(3, "edit", { path: "b.ts", oldText: "a", newText: "b" }),
        tool(4, "write", { path: "c.ts", content: "c" }),
      ]),
    ).toBe("Ran 2 commands, edited 3 files");
  });

  it("counts edits made through bash as commands", () => {
    expect(
      activitySummary([
        tool(0, "bash", { command: "sed -i 's/a/b/' a.ts" }),
        tool(1, "bash", { command: "cat > b.ts <<'EOF'\nb\nEOF" }),
      ]),
    ).toBe("Ran 2 commands");
  });

  it("counts distinct files and keeps first-appearance order", () => {
    expect(
      activitySummary([
        tool(0, "read", { path: "a.ts" }),
        tool(1, "edit", { path: "a.ts", oldText: "a", newText: "b" }),
        tool(2, "edit", { path: "a.ts", oldText: "b", newText: "c" }),
        tool(3, "read", { path: "b.ts" }),
      ]),
    ).toBe("Read 2 files, edited 1 file");
  });
});
