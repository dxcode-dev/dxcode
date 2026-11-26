import type { TranscriptRow } from "@dx/client";
import { describe, expect, it } from "vitest";
import { isShownWork } from "./simple-turn-model.js";

// How the Simple view could lose a plugin's card, and the case for each:
// - leaves out a tool result that names one of its plugin's views;
// - shows every plugin tool's row as if it were a card the agent made.

/** A finished tool call whose result is `output`, as dx's agent hands it over. */
const toolRow = (toolName: string, output: unknown): TranscriptRow =>
  ({
    kind: "settled-work",
    id: `row-${toolName}`,
    turnId: "turn-1",
    messageId: "message-1",
    partIndex: 0,
    part: {
      type: "dynamic-tool",
      toolName,
      toolCallId: `call-${toolName}`,
      state: "output-available",
      input: {},
      output,
    },
  }) as unknown as TranscriptRow;

describe("the Simple view's shown work", () => {
  it("shows a plugin tool's result that names one of its views as a card", () => {
    expect(
      isShownWork(
        toolRow(
          "log_summary",
          JSON.stringify({
            errors: 3,
            _meta: { "dev.dxcode/view": "dashboard" },
          }),
        ),
      ),
    ).toBe(true);
  });

  it("leaves out a plugin tool's result that names no view", () => {
    expect(
      isShownWork(
        toolRow("log_watch_counts", JSON.stringify({ lines: 12, errors: 3 })),
      ),
    ).toBe(false);
  });
});
