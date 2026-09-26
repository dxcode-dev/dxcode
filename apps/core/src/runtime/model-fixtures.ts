import {
  type Context,
  createProvider,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { setProvider } from "@flue/runtime";
import { Schema } from "effect";
import {
  LOCAL_MODEL_FIXTURE_MODEL,
  LOCAL_MODEL_FIXTURE_PROVIDER,
} from "./model-fixture-route.js";

export const LOCAL_MODEL_FIXTURE_AUDIT_MARKER =
  "dx-local-model-fixture-v1" as const;

export const LOCAL_MODEL_FIXTURE_PROMPTS = {
  textCompletion:
    "Reply with two short sentences confirming this synthetic model-stream check. Do not use tools.",
  toolContinuation:
    "Use the write tool to create /home/user/workspace/repo/.dx-glm-journey.txt containing exactly synthetic-glm-tool-result. After the tool result, reply with one short confirmation sentence.",
} as const;

export const LOCAL_MODEL_FAILURE_FIXTURE_PROMPTS = {
  error: "[dx fixture] deterministic model error",
  cancellation: "[dx fixture] deterministic model cancellation",
  retry: "[dx fixture] deterministic transient retry",
  disconnect: "[dx fixture] deterministic provider disconnect",
} as const;

export type LocalModelFixtureKind = keyof typeof LOCAL_MODEL_FIXTURE_PROMPTS;

export interface LocalModelFixtureDefinition {
  readonly kind: LocalModelFixtureKind;
  readonly prompt: string;
  readonly authored: true;
  readonly reviewed: true;
}

export const localModelFixtureDefinitions: readonly LocalModelFixtureDefinition[] =
  Object.freeze(
    Object.entries(LOCAL_MODEL_FIXTURE_PROMPTS).map(([kind, prompt]) => ({
      kind: kind as LocalModelFixtureKind,
      prompt,
      authored: true as const,
      reviewed: true as const,
    })),
  );

const LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE =
  "The local model accepts only the two approved synthetic fixture prompts." as const;

export class LocalModelFixtureMismatch extends Schema.TaggedError<LocalModelFixtureMismatch>()(
  "LocalModelFixtureMismatch",
  { message: Schema.Literal(LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE) },
) {}

const fixtureMismatch = () =>
  new LocalModelFixtureMismatch({
    message: LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE,
  });

const promptFromContext = (context: Context) => {
  const message = context.messages.findLast(({ role }) => role === "user");
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.length === 1 && message.content[0]?.type === "text")
    return message.content[0].text;
  return undefined;
};

export const localModelFixtureForPrompt = (prompt: string | undefined) => {
  const fixture = localModelFixtureDefinitions.find(
    (candidate) => candidate.prompt === prompt,
  );
  if (fixture === undefined) throw fixtureMismatch();
  return fixture;
};

const LOCAL_MODEL_FIXTURE_TOOL_CALL_ID = "dx-local-fixture-write";

const hasSuccessfulFixtureToolResult = (context: Context) => {
  const promptIndex = context.messages.findLastIndex(
    ({ role }) => role === "user",
  );
  const continuation = context.messages.slice(promptIndex + 1);
  const toolCall = continuation.find(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (content) =>
          content.type === "toolCall" &&
          content.id === LOCAL_MODEL_FIXTURE_TOOL_CALL_ID &&
          content.name === "write" &&
          JSON.stringify(content.arguments) ===
            JSON.stringify({
              path: "/home/user/workspace/repo/.dx-glm-journey.txt",
              content: "synthetic-glm-tool-result",
            }),
      ),
  );
  const toolResult = continuation.find(
    (message) =>
      message.role === "toolResult" &&
      message.toolCallId === LOCAL_MODEL_FIXTURE_TOOL_CALL_ID &&
      message.toolName === "write",
  );
  if (toolCall === undefined && toolResult === undefined) return false;
  if (
    toolCall === undefined ||
    toolResult?.role !== "toolResult" ||
    toolResult.isError
  )
    throw fixtureMismatch();
  return true;
};

export type LocalModelFailureFixtureKind =
  keyof typeof LOCAL_MODEL_FAILURE_FIXTURE_PROMPTS;

export const localModelFailureFixture = (
  kind: LocalModelFailureFixtureKind,
  attempt = 1,
) => {
  switch (kind) {
    case "error":
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Authored deterministic model failure.",
        timestamp: 0,
      });
    case "cancellation":
      return fauxAssistantMessage([], {
        stopReason: "aborted",
        errorMessage: "Authored deterministic cancellation.",
        timestamp: 0,
      });
    case "retry":
      return attempt === 1
        ? fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "Authored transient model failure.",
            timestamp: 0,
          })
        : fauxAssistantMessage("Authored deterministic retry completed.", {
            timestamp: 0,
          });
    case "disconnect":
      throw new Error("Authored deterministic provider disconnect.");
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

export const createLocalModelFixtureProvider = () => {
  const model: Model<typeof LOCAL_MODEL_FIXTURE_AUDIT_MARKER> = {
    id: LOCAL_MODEL_FIXTURE_MODEL,
    name: "Reviewed GLM 5.3 Flash local fixture",
    api: LOCAL_MODEL_FIXTURE_AUDIT_MARKER,
    provider: LOCAL_MODEL_FIXTURE_PROVIDER,
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 262_144,
  };
  const fixtureCore = (context: Context) => {
    const fixture = localModelFixtureForPrompt(promptFromContext(context));
    const core = createFauxCore({
      api: LOCAL_MODEL_FIXTURE_AUDIT_MARKER,
      provider: LOCAL_MODEL_FIXTURE_PROVIDER,
      models: [{ id: LOCAL_MODEL_FIXTURE_MODEL, reasoning: true }],
      tokenSize: { min: 2, max: 2 },
    });
    switch (fixture.kind) {
      case "textCompletion":
        core.setResponses([
          fauxAssistantMessage(
            [
              fauxText("The synthetic model stream completed."),
              fauxText("No paid provider was called."),
            ],
            {
              timestamp: 0,
            },
          ),
        ]);
        break;
      case "toolContinuation":
        core.setResponses([
          hasSuccessfulFixtureToolResult(context)
            ? fauxAssistantMessage(
                "The synthetic file change completed successfully.",
                { timestamp: 0 },
              )
            : fauxAssistantMessage(
                fauxToolCall(
                  "write",
                  {
                    path: "/home/user/workspace/repo/.dx-glm-journey.txt",
                    content: "synthetic-glm-tool-result",
                  },
                  { id: LOCAL_MODEL_FIXTURE_TOOL_CALL_ID },
                ),
                {
                  stopReason: "toolUse",
                  timestamp: 0,
                },
              ),
        ]);
        break;
      default: {
        const exhaustive: never = fixture.kind;
        return exhaustive;
      }
    }
    return core;
  };
  const stream = (
    requestModel: Model<typeof LOCAL_MODEL_FIXTURE_AUDIT_MARKER>,
    context: Context,
    options?: StreamOptions,
  ) => fixtureCore(context).stream(requestModel, context, options);
  const streamSimple = (
    requestModel: Model<typeof LOCAL_MODEL_FIXTURE_AUDIT_MARKER>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => fixtureCore(context).streamSimple(requestModel, context, options);
  return createProvider({
    id: LOCAL_MODEL_FIXTURE_PROVIDER,
    name: "Reviewed local model fixtures",
    auth: {
      apiKey: { name: "Local fixture", resolve: async () => ({ auth: {} }) },
    },
    models: [model],
    api: { stream, streamSimple },
  });
};

export const registerLocalModelFixtureProvider = () => {
  setProvider(createLocalModelFixtureProvider());
};
