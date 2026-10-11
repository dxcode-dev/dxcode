import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createLocalModelFixtureProvider,
  LOCAL_MODEL_FIXTURE_PROMPTS,
  LocalModelFixtureMismatch,
  localModelFixtureForPrompt,
} from "./model-fixtures.js";

const context = (prompt: string): Context => ({
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 0,
    },
  ],
});

describe("local model fixtures", () => {
  it("fails unknown prompts closed before any provider transport", () => {
    expect(() => localModelFixtureForPrompt("unknown prompt")).toThrowError(
      expect.objectContaining({
        _tag: "LocalModelFixtureMismatch",
        message:
          "The local model accepts only the approved synthetic fixture prompts.",
      }),
    );
    const provider = createLocalModelFixtureProvider();
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Fixture model is missing.");
    expect(() => provider.stream(model, context("unknown prompt"))).toThrow(
      LocalModelFixtureMismatch,
    );
  });

  it("emits a create_file call and continues only after its matching tool result", async () => {
    const provider = createLocalModelFixtureProvider();
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Fixture model is missing.");
    const initial: AssistantMessageEvent[] = [];
    for await (const event of provider.stream(
      model,
      context(LOCAL_MODEL_FIXTURE_PROMPTS.toolContinuation),
    ))
      initial.push(event);
    const toolUse = initial.at(-1);
    if (toolUse?.type !== "done")
      throw new Error("Tool fixture did not complete.");
    expect(toolUse).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        content: [
          {
            type: "toolCall",
            id: "dx-local-fixture-write",
            name: "create_file",
            arguments: {
              path: "/home/user/workspace/repo/.dx-glm-journey.txt",
              content: "synthetic-glm-tool-result",
            },
          },
        ],
      },
    });

    const continued: AssistantMessageEvent[] = [];
    for await (const event of provider.stream(model, {
      messages: [
        ...context(LOCAL_MODEL_FIXTURE_PROMPTS.toolContinuation).messages,
        toolUse.message,
        {
          role: "toolResult",
          toolCallId: "dx-local-fixture-write",
          toolName: "create_file",
          content: [{ type: "text", text: "Successfully wrote 25 bytes" }],
          isError: false,
          timestamp: 0,
        },
      ],
    }))
      continued.push(event);
    expect(continued.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: {
        content: [
          {
            type: "text",
            text: "The synthetic file change completed successfully.",
          },
        ],
      },
    });

    expect(() =>
      provider.stream(model, {
        messages: [
          ...context(LOCAL_MODEL_FIXTURE_PROMPTS.toolContinuation).messages,
          toolUse.message,
          {
            role: "toolResult",
            toolCallId: "dx-local-fixture-write",
            toolName: "create_file",
            content: [{ type: "text", text: "write failed" }],
            isError: true,
            timestamp: 0,
          },
        ],
      }),
    ).toThrow(LocalModelFixtureMismatch);
  });
});
