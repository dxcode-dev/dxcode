import { parseMessageAuthor } from "@dx/api";
import {
  type Context,
  createProvider,
  getCurrentSystemPrompt,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { setProvider } from "@flue/runtime";
import { Schema } from "effect";
import { RICH_REPLY_TEXT } from "./model-fixture-rich-reply.js";
import {
  LOCAL_MODEL_FIXTURE_MODEL,
  LOCAL_MODEL_FIXTURE_PROVIDER,
} from "./model-fixture-route.js";

const LOCAL_MODEL_FIXTURE_AUDIT_MARKER = "dx-local-model-fixture-v1" as const;

const LOCAL_MODEL_FIXTURE_PROMPTS_TEXT_COMPLETION =
  "Reply with two short sentences confirming this synthetic model-stream check. Do not use tools.";
const LOCAL_MODEL_FIXTURE_PROMPTS_REPORT_TO_PARENT =
  "Run the synthetic check, then send its result to the thread that started you.";
const LOCAL_MODEL_FIXTURE_PROMPTS_CHILD_REPORT =
  "Synthetic child report: the synthetic check completed.";

export const LOCAL_MODEL_FIXTURE_PROMPTS = {
  textCompletion: LOCAL_MODEL_FIXTURE_PROMPTS_TEXT_COMPLETION,
  toolContinuation:
    "Use the create_file tool to create /home/user/workspace/repo/.dx-glm-journey.txt containing exactly synthetic-glm-tool-result. After the tool result, reply with one short confirmation sentence.",
  childThread:
    "Use the create_thread tool to start a child thread titled Synthetic child thread that runs the synthetic model-stream check. After the tool result, reply with one short confirmation sentence.",
  threadColor:
    "Use the update_thread tool to color this thread green. After the tool result, reply with one short confirmation sentence.",
  richReply:
    "Reply with the synthetic rich reply: two views, an image, a video, and audio from the workspace. Do not use tools.",
  reportingChild:
    "Use the create_thread tool to start a child thread titled Synthetic reporting child that runs the synthetic check and reports back. After the tool result, reply with one short sentence and end your turn.",
  reportToParent: LOCAL_MODEL_FIXTURE_PROMPTS_REPORT_TO_PARENT,
  childReport: LOCAL_MODEL_FIXTURE_PROMPTS_CHILD_REPORT,
} as const;

/** The tool call each tool fixture makes before its confirmation. */
const LOCAL_MODEL_FIXTURE_TOOL_CALLS = {
  toolContinuation: {
    id: "dx-local-fixture-write",
    name: "create_file",
    arguments: {
      path: "/home/user/workspace/repo/.dx-glm-journey.txt",
      content: "synthetic-glm-tool-result",
    },
    confirmation: "The synthetic file change completed successfully.",
  },
  childThread: {
    id: "dx-local-fixture-child-thread",
    name: "create_thread",
    arguments: {
      prompt: LOCAL_MODEL_FIXTURE_PROMPTS_TEXT_COMPLETION,
      title: "Synthetic child thread",
    },
    confirmation: "The synthetic child thread started.",
  },
  threadColor: {
    id: "dx-local-fixture-thread-color",
    name: "update_thread",
    arguments: { color: "green" },
    confirmation: "This thread is green now.",
  },
  reportingChild: {
    id: "dx-local-fixture-reporting-child",
    name: "create_thread",
    arguments: {
      prompt: LOCAL_MODEL_FIXTURE_PROMPTS_REPORT_TO_PARENT,
      title: "Synthetic reporting child",
    },
    confirmation:
      "The synthetic reporting child started; its report will arrive here.",
  },
} as const;

/**
 * The report a child sends the Thread that started it, which only its
 * system prompt names: a Thread that was not started by an agent has none.
 */
const reportToParentCall = (context: Context) => {
  const thread =
    /The agent of Thread (thr_[0-9a-f-]{36}) started this Thread\./.exec(
      getCurrentSystemPrompt(context.messages) ?? "",
    )?.[1];
  if (thread === undefined) throw fixtureMismatch();
  return {
    id: "dx-local-fixture-report-to-parent",
    name: "send_thread_message",
    arguments: { thread, message: LOCAL_MODEL_FIXTURE_PROMPTS_CHILD_REPORT },
    confirmation: "The synthetic report was sent.",
  };
};

export type LocalModelFixtureKind = keyof typeof LOCAL_MODEL_FIXTURE_PROMPTS;

export interface LocalModelFixtureDefinition {
  readonly kind: LocalModelFixtureKind;
  readonly prompt: string;
  readonly authored: true;
  readonly reviewed: true;
}

const localModelFixtureDefinitions: readonly LocalModelFixtureDefinition[] =
  Object.freeze(
    Object.entries(LOCAL_MODEL_FIXTURE_PROMPTS).map(([kind, prompt]) => ({
      kind: kind as LocalModelFixtureKind,
      prompt,
      authored: true as const,
      reviewed: true as const,
    })),
  );

const LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE =
  "The local model accepts only the approved synthetic fixture prompts." as const;

export class LocalModelFixtureMismatch extends Schema.TaggedError<LocalModelFixtureMismatch>()(
  "LocalModelFixtureMismatch",
  { message: Schema.Literal(LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE) },
) {}

const fixtureMismatch = () =>
  new LocalModelFixtureMismatch({
    message: LOCAL_MODEL_FIXTURE_MISMATCH_MESSAGE,
  });

// dx prefixes each user message with its author tag; fixtures match the
// prompt the person wrote, without a leading `@dx` that sent it to the agent
// in a shared Thread.
const writtenPrompt = (text: string) =>
  parseMessageAuthor(text).text.replace(/^@dx\s+/, "");

const promptFromContext = (context: Context) => {
  const message = context.messages.findLast(({ role }) => role === "user");
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string")
    return writtenPrompt(message.content);
  if (message.content.length === 1 && message.content[0]?.type === "text")
    return writtenPrompt(message.content[0].text);
  return undefined;
};

export const localModelFixtureForPrompt = (prompt: string | undefined) => {
  const fixture = localModelFixtureDefinitions.find(
    (candidate) => candidate.prompt === prompt,
  );
  if (fixture === undefined) throw fixtureMismatch();
  return fixture;
};

interface FixtureToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly confirmation: string;
}

const hasSuccessfulFixtureToolResult = (
  context: Context,
  expected: FixtureToolCall,
) => {
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
          content.id === expected.id &&
          content.name === expected.name &&
          JSON.stringify(content.arguments) ===
            JSON.stringify(expected.arguments),
      ),
  );
  const toolResult = continuation.find(
    (message) =>
      message.role === "toolResult" &&
      message.toolCallId === expected.id &&
      message.toolName === expected.name,
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
      // The rich reply streams over a few seconds, so a reader sees its
      // views render while the rest of the reply still arrives.
      ...(fixture.kind === "richReply" ? { tokensPerSecond: 600 } : {}),
      ...(fixture.kind === "reportToParent" ? { tokensPerSecond: 5 } : {}),
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
      case "richReply":
        core.setResponses([
          fauxAssistantMessage(RICH_REPLY_TEXT, { timestamp: 0 }),
        ]);
        break;
      case "childReport":
        core.setResponses([
          fauxAssistantMessage("The synthetic child report arrived.", {
            timestamp: 0,
          }),
        ]);
        break;
      case "toolContinuation":
      case "childThread":
      case "threadColor":
      case "reportingChild":
      case "reportToParent": {
        const expected =
          fixture.kind === "reportToParent"
            ? reportToParentCall(context)
            : LOCAL_MODEL_FIXTURE_TOOL_CALLS[fixture.kind];
        core.setResponses([
          hasSuccessfulFixtureToolResult(context, expected)
            ? fauxAssistantMessage(expected.confirmation, { timestamp: 0 })
            : fauxAssistantMessage(
                [
                  // The child works a few seconds first, so its report
                  // reaches a parent that has ended its turn.
                  ...(fixture.kind === "reportToParent"
                    ? [
                        fauxText(
                          "Running the synthetic check before reporting.",
                        ),
                      ]
                    : []),
                  fauxToolCall(expected.name, expected.arguments, {
                    id: expected.id,
                  }),
                ],
                {
                  stopReason: "toolUse",
                  timestamp: 0,
                },
              ),
        ]);
        break;
      }
      default: {
        const exhaustive: never = fixture.kind;
        return exhaustive;
      }
    }
    return core;
  };
  const stream = (
    requestModel: Model<typeof LOCAL_MODEL_FIXTURE_AUDIT_MARKER>,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => fixtureCore(context).stream(requestModel, context, options);
  const streamSimple = (
    requestModel: Model<typeof LOCAL_MODEL_FIXTURE_AUDIT_MARKER>,
    context: TranscriptContext,
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
