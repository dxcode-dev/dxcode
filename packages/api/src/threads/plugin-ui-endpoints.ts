import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  AnswerPluginPromptRequestSchema,
  AnswerPluginPromptResponseSchema,
  PluginPaneIceServersResponseSchema,
  PluginPaneMessagesResponseSchema,
  PluginPaneViewResponseSchema,
  PluginThreadUiErrorResponseSchema,
  PluginThreadUiResponseSchema,
  PostPluginPaneMessageRequestSchema,
  PostPluginPaneMessageResponseSchema,
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
/** One plugin's pane: the plugin's manifest name and the pane's ID. */
export const PluginPaneParamsSchema = Schema.Struct({
  threadId: ThreadId,
  plugin: Schema.String,
  pane: Schema.String,
});
/** `after`: only posts newer than this `seq`. */
export const PluginPaneMessagesQuerySchema = Schema.Struct({
  after: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9]+$/))),
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

export const GetPluginPaneViewEndpoint = defineEndpoint({
  id: "threads.pluginUi.pane.view",
  summary: "Read a plugin pane's view",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/panes/:plugin/:pane",
  params: PluginPaneParamsSchema,
  success: PluginPaneViewResponseSchema,
  refusals: pluginThreadUiRefusals,
});

export const ListPluginPaneMessagesEndpoint = defineEndpoint({
  id: "threads.pluginUi.pane.messages",
  summary: "List a plugin pane's messages",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/panes/:plugin/:pane/messages",
  params: PluginPaneParamsSchema,
  query: PluginPaneMessagesQuerySchema,
  success: PluginPaneMessagesResponseSchema,
  refusals: pluginThreadUiRefusals,
});

export const PostPluginPaneMessageEndpoint = defineEndpoint({
  id: "threads.pluginUi.pane.postMessage",
  summary: "Send a message to a plugin pane",
  method: "POST",
  path: "/v1/threads/:threadId/plugin-ui/panes/:plugin/:pane/messages",
  params: PluginPaneParamsSchema,
  body: PostPluginPaneMessageRequestSchema,
  success: PostPluginPaneMessageResponseSchema,
  refusals: pluginThreadUiRefusals,
});

/**
 * WebRTC ICE servers for a trusted pane that declares `connect.webrtc`. Its
 * refusals (`{ error, code }`, not dx's error envelope) read as "Request
 * failed.".
 */
export const GetPluginPaneIceServersEndpoint = defineEndpoint({
  id: "threads.pluginUi.pane.iceServers",
  summary: "Read ICE servers for a plugin pane",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/panes/:plugin/:pane/ice-servers",
  params: PluginPaneParamsSchema,
  success: PluginPaneIceServersResponseSchema,
  refusals: ThreadAccessRefusals,
});

/**
 * A trusted pane's live stream: a WebSocket a signed-in browser opens at
 * `endpointPath` (with the `ws:` scheme), not a request `call` makes. Its
 * frames are the plugin's; dx's own news starts with `\u0000`.
 */
export const PluginPaneStreamEndpoint = defineEndpoint({
  id: "threads.pluginUi.pane.stream",
  summary: "Stream a plugin pane's messages",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/panes/:plugin/:pane/stream",
  params: PluginPaneParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: ThreadAccessRefusals,
});
