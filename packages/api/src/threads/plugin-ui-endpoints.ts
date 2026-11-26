import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  AnswerPluginPromptRequestSchema,
  AnswerPluginPromptResponseSchema,
  PluginThreadUiErrorResponseSchema,
  PluginThreadUiResponseSchema,
  RunPluginCommandRequestSchema,
  RunPluginCommandResponseSchema,
} from "./plugin-ui.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The plugin UI endpoints, apart from `plugin-ui.ts`'s schemas. */

export const PluginThreadUiParamsSchema = Schema.Struct({ threadId: ThreadId });
export const AnswerPluginPromptParamsSchema = Schema.Struct({
  threadId: ThreadId,
  promptId: Schema.String,
});

// Each code goes out with its own status (400, 403, 404, 409, or 502).
const pluginThreadUiRefusals = [
  ...ThreadAccessRefusals,
  // One union of codes, each sent with its own status.
  ...([400, 403, 404, 409, 502] as const).map((status) => ({
    status,
    schema: PluginThreadUiErrorResponseSchema,
  })),
] as const;

export const GetPluginThreadUiEndpoint = defineEndpoint({
  id: "threads.pluginUi.get",
  summary: "Read a Thread's plugin UI",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui",
  params: PluginThreadUiParamsSchema,
  success: PluginThreadUiResponseSchema,
  refusals: pluginThreadUiRefusals,
});

export const AnswerPluginPromptEndpoint = defineEndpoint({
  id: "threads.pluginUi.answerPrompt",
  summary: "Answer a plugin prompt",
  method: "POST",
  path: "/v1/threads/:threadId/plugin-ui/prompts/:promptId",
  params: AnswerPluginPromptParamsSchema,
  body: AnswerPluginPromptRequestSchema,
  success: AnswerPluginPromptResponseSchema,
  refusals: pluginThreadUiRefusals,
});

export const RunPluginCommandEndpoint = defineEndpoint({
  id: "threads.pluginUi.runCommand",
  summary: "Run a plugin palette command",
  method: "POST",
  path: "/v1/threads/:threadId/plugin-ui/commands",
  params: PluginThreadUiParamsSchema,
  body: RunPluginCommandRequestSchema,
  success: RunPluginCommandResponseSchema,
  refusals: pluginThreadUiRefusals,
});
