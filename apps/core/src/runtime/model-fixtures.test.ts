import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createLocalModelFixtureProvider,
  LOCAL_MODEL_FAILURE_FIXTURE_PROMPTS,
  LOCAL_MODEL_FIXTURE_AUDIT_MARKER,
  LOCAL_MODEL_FIXTURE_PROMPTS,
  LocalModelFixtureMismatch,
  localModelFailureFixture,
  localModelFixtureDefinitions,
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

const eventsFor = async (
  provider: ReturnType<typeof createLocalModelFixtureProvider>,
  prompt: string,
) => {
  const model = provider.getModels()[0];
  if (model === undefined) throw new Error("Fixture model is missing.");
  const events: AssistantMessageEvent[] = [];
  for await (const event of provider.stream(model, context(prompt))) {
    events.push(event);
  }
  return events;
};

describe("local model fixtures", () => {
  it("selects exactly the two reviewed synthetic success prompts", () => {
    expect(localModelFixtureDefinitions.map(({ kind }) => kind)).toEqual([
      "textCompletion",
      "toolContinuation",
    ]);
    expect(localModelFixtureDefinitions).toHaveLength(2);
    expect(localModelFixtureDefinitions).toEqual([
      expect.objectContaining({ authored: true, reviewed: true }),
      expect.objectContaining({ authored: true, reviewed: true }),
    ]);
  });

  it("fails unknown prompts closed before any provider transport", () => {
    expect(() => localModelFixtureForPrompt("unknown prompt")).toThrowError(
      expect.objectContaining({
        _tag: "LocalModelFixtureMismatch",
        message:
          "The local model accepts only the two approved synthetic fixture prompts.",
      }),
    );
    const provider = createLocalModelFixtureProvider();
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Fixture model is missing.");
    expect(() => provider.stream(model, context("unknown prompt"))).toThrow(
      LocalModelFixtureMismatch,
    );
  });

  it("streams the reviewed text completion through the deployment-shaped provider contract", async () => {
    const provider = createLocalModelFixtureProvider();
    const events = await eventsFor(
      provider,
      LOCAL_MODEL_FIXTURE_PROMPTS.textCompletion,
    );
    expect(
      events.filter(({ type }) => type === "text_delta").length,
    ).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: {
        content: [
          { type: "text", text: "The synthetic model stream completed." },
          { type: "text", text: "No paid provider was called." },
        ],
      },
    });
    expect(provider.getModels()[0]).toMatchObject({
      provider: "dx-local-fixture",
      id: "glm-5.3-flash",
      api: LOCAL_MODEL_FIXTURE_AUDIT_MARKER,
    });
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

  it("keeps deterministic authored failure fixtures outside prompt selection", () => {
    expect(Object.keys(LOCAL_MODEL_FAILURE_FIXTURE_PROMPTS)).toEqual([
      "error",
      "cancellation",
      "retry",
      "disconnect",
    ]);
    expect(localModelFailureFixture("error")).toMatchObject({
      stopReason: "error",
    });
    expect(localModelFailureFixture("cancellation")).toMatchObject({
      stopReason: "aborted",
    });
    expect(localModelFailureFixture("retry", 1)).toMatchObject({
      stopReason: "error",
    });
    expect(localModelFailureFixture("retry", 2)).toMatchObject({
      stopReason: "stop",
    });
    expect(() => localModelFailureFixture("disconnect")).toThrow(
      "Authored deterministic provider disconnect.",
    );
  });
});
