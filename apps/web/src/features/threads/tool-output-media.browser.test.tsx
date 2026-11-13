import type { FlueConversationMessage } from "@flue/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolMediaSourceContext } from "./tool-output-media-model.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";
import { TranscriptTurn } from "./transcript-work.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());

const AGENT = "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000001";
const IMAGE_ID = "att_entry_tool_outcome_abc_1";

type ToolPart = Extract<
  FlueConversationMessage["parts"][number],
  { type: "dynamic-tool" }
>;

/** One finished turn whose only work is the given tool call. */
const renderToolCall = async (part: Omit<ToolPart, "type" | "state">) => {
  const model = deriveTranscriptViewModel({
    messages: [
      {
        id: "prompt",
        role: "user",
        purpose: "user",
        display: "visible",
        turnId: "turn",
        parts: [{ type: "text", text: "Look at it", state: "done" }],
      },
      {
        id: "answer",
        role: "assistant",
        purpose: "assistant",
        display: "visible",
        turnId: "turn",
        submissionId: "submission",
        metadata: { dxResponseStartedAt: "2026-11-10T12:00:00.000Z" },
        parts: [
          { type: "dynamic-tool", state: "output-available", ...part },
          { type: "text", text: "Seen.", state: "done" },
        ] as FlueConversationMessage["parts"],
      },
    ],
    settlements: [{ submissionId: "submission", outcome: "completed" }],
    finalOutputs: [
      {
        hostSubmissionId: "submission",
        messageId: "answer",
        timestamp: "2026-11-10T12:00:01.000Z",
        position: { batch: 1, index: 1 },
      },
    ],
  });
  const turn = model.turns[0];
  if (turn === undefined) throw new Error("Expected a turn");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <ToolMediaSourceContext
        value={(id) => `${AGENT}/attachments/${encodeURIComponent(id)}`}
      >
        <TranscriptTurn
          turn={turn}
          rows={model.rows}
          renderRow={(row) => <div key={row.id}>{row.kind}</div>}
          defaultWorkExpanded
        />
      </ToolMediaSourceContext>,
    ),
  );
  const row = container.querySelector<HTMLDetailsElement>(
    "details.transcript-activity-row",
  );
  if (row === null) throw new Error("Expected an expandable tool row");
  await React.act(() => {
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
  });
  return { container, row, root };
};

describe("tool output media", () => {
  it("shows view_media's text and its image as a tile, never the raw blocks", async () => {
    const { row, root } = await renderToolCall({
      toolName: "view_media",
      toolCallId: "view",
      input: { path: "/home/user/attachments/shot.png" },
      output: [
        {
          type: "text",
          text: "/home/user/attachments/shot.png: PNG, 722×1600.",
        },
        { type: "image", data: IMAGE_ID, mimeType: "image/png" },
      ],
    });
    expect(row.textContent).toContain(
      "/home/user/attachments/shot.png: PNG, 722×1600.",
    );
    expect(row.textContent).not.toContain('"type"');
    expect(row.textContent).not.toContain(IMAGE_ID);
    const tile = row.querySelector<HTMLButtonElement>(
      "button.message-image-tile",
    );
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe(
      `${AGENT}/attachments/${IMAGE_ID}`,
    );
    await React.act(() => tile?.click());
    // The viewer loads on first open.
    await vi.waitFor(() =>
      expect(
        document
          .querySelector(".dx-image-viewer")
          ?.querySelector("img")
          ?.getAttribute("src"),
      ).toBe(`${AGENT}/attachments/${IMAGE_ID}`),
    );
    await React.act(() => root.unmount());
  });

  it("shows view_media's answer to an objective as prose", async () => {
    const { row, root } = await renderToolCall({
      toolName: "view_media",
      toolCallId: "analyze",
      input: { path: "/tmp/shot.png", objective: "What is the title?" },
      output: "The header reads **Reports**.",
    });
    expect(row.textContent).toContain("The header reads Reports.");
    expect(row.querySelector("strong")?.textContent).toBe("Reports");
    await React.act(() => root.unmount());
  });

  it("shows an image Claude Code's Read returned instead of [image]", async () => {
    const { row, root } = await renderToolCall({
      toolName: "Read",
      toolCallId: "read",
      input: { file_path: "/home/user/workspace/repo/failure.png" },
      output: [{ type: "image", data: IMAGE_ID, mimeType: "image/png" }],
    });
    expect(row.textContent).toContain("failure.png");
    expect(row.textContent).not.toContain("[image]");
    expect(
      row.querySelector("button.message-image-tile img")?.getAttribute("src"),
    ).toBe(`${AGENT}/attachments/${IMAGE_ID}`);
    await React.act(() => root.unmount());
  });
});
