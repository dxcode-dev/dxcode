import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { ThreadAccessRefusals } from "../threads/thread-access-refusals.js";
import {
  PluginAppErrorResponseSchema,
  PluginAppsResponseSchema,
  PluginAppUrlResponseSchema,
} from "./plugin-apps.js";
import {
  PluginDataViewCallRequestSchema,
  PluginDataViewCallResponseSchema,
  PluginDataViewErrorResponseSchema,
  PluginDataViewStateResponseSchema,
} from "./plugin-data-views.js";

/**
 * Views described as data (`plugin-data-views.ts`) and a plugin's own web
 * app (`plugin-apps.ts`): on a page, the caller's own installs; inside a
 * Thread, the Thread's. In their own module, so the Thread page's first
 * load does not carry them (wiki/headless-client.md).
 */

const viewRefusals = [
  { status: 400, schema: PluginDataViewErrorResponseSchema },
  { status: 403, schema: PluginDataViewErrorResponseSchema },
  { status: 404, schema: PluginDataViewErrorResponseSchema },
  { status: 502, schema: PluginDataViewErrorResponseSchema },
];

const appRefusals = [
  { status: 404, schema: PluginAppErrorResponseSchema },
  { status: 503, schema: PluginAppErrorResponseSchema },
];

const PageViewParamsSchema = Schema.Struct({
  plugin: Schema.String,
  view: Schema.String,
});

const ThreadViewParamsSchema = Schema.Struct({
  threadId: ThreadId,
  plugin: Schema.String,
  view: Schema.String,
});

/** A view file, by its install and the sha256 of its text. */
export const GetPluginDataViewDefinitionEndpoint = defineEndpoint({
  id: "pluginViews.definition.get",
  method: "GET",
  path: "/v1/plugins/views/definitions/:installId/:integrity",
  params: Schema.Struct({ installId: Schema.String, integrity: Schema.String }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: viewRefusals,
});

export const GetPluginDataViewStateEndpoint = defineEndpoint({
  id: "pluginViews.state.get",
  method: "GET",
  path: "/v1/plugins/views/:plugin/data/:view/state",
  params: PageViewParamsSchema,
  success: PluginDataViewStateResponseSchema,
  refusals: viewRefusals,
});

export const CallPluginDataViewEndpoint = defineEndpoint({
  id: "pluginViews.call",
  method: "POST",
  path: "/v1/plugins/views/:plugin/data/:view/call",
  params: PageViewParamsSchema,
  body: PluginDataViewCallRequestSchema,
  success: PluginDataViewCallResponseSchema,
  refusals: viewRefusals,
});

/**
 * A view file through the Thread: how a draft's view, which no install
 * stores, reaches the people who can open the Thread that loaded it. `v`
 * is the file's sha256, so a reload's new file has a new address.
 */
export const GetThreadPluginDataViewDefinitionEndpoint = defineEndpoint({
  id: "threads.pluginViews.definition.get",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/views/:plugin/:view/definition",
  params: ThreadViewParamsSchema,
  query: Schema.Struct({ v: Schema.String }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: [...ThreadAccessRefusals, ...viewRefusals],
});

export const GetThreadPluginDataViewStateEndpoint = defineEndpoint({
  id: "threads.pluginViews.state.get",
  method: "GET",
  path: "/v1/threads/:threadId/plugin-ui/views/:plugin/:view/state",
  params: ThreadViewParamsSchema,
  success: PluginDataViewStateResponseSchema,
  refusals: [...ThreadAccessRefusals, ...viewRefusals],
});

export const CallThreadPluginDataViewEndpoint = defineEndpoint({
  id: "threads.pluginViews.call",
  method: "POST",
  path: "/v1/threads/:threadId/plugin-ui/views/:plugin/:view/call",
  params: ThreadViewParamsSchema,
  body: PluginDataViewCallRequestSchema,
  success: PluginDataViewCallResponseSchema,
  refusals: [...ThreadAccessRefusals, ...viewRefusals],
});

/** The caller's plugins that have their own web app. */
export const ListPluginAppsEndpoint = defineEndpoint({
  id: "pluginApps.list",
  method: "GET",
  path: "/v1/plugins/views/apps",
  success: PluginAppsResponseSchema,
  refusals: appRefusals,
});

/** Where the app's frame loads now; starting it can wake its plugin Orb. */
export const GetPluginAppUrlEndpoint = defineEndpoint({
  id: "pluginApps.url.get",
  method: "GET",
  path: "/v1/plugins/views/:plugin/app",
  params: Schema.Struct({ plugin: Schema.String }),
  success: PluginAppUrlResponseSchema,
  refusals: appRefusals,
});
