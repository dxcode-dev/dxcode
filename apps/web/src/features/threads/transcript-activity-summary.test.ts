import { describe, expect, it } from "vitest";
import { activitySummary } from "./transcript-activities.js";
import type { WorkRow } from "./transcript-activity-projection.js";

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
