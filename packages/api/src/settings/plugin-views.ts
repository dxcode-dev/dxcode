import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { PluginDataViewOption } from "./plugin-data-views.js";

/**
 * The views catalog and Thread types. A Thread type is a view described as
 * data with `show: ["app"]`: it draws a Thread's main area with the chat
 * beside it.
 */

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const ViewId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/));

/** `lucide:<name>` or an icon asset's sha256 (per-item icon). */
export const PluginViewIconSchema = Schema.String.check(
  Schema.isPattern(/^(?:lucide:[a-z0-9-]{1,64}|[0-9a-f]{64})$/),
);

/**
 * The Thread's plugin type, as it resolves now: `available` false when the
 * plugin is off, removed, or below the trusted tier; the Thread then opens
 * as a plain chat with a notice.
 */
export const PluginThreadTypeEntry = Schema.Struct({
  /** `<plugin>/<type>` as stored on the Thread. */
  ref: Text(130),
  plugin: Text(96),
  type: ViewId,
  /** The type's title, or its id when the plugin is gone. */
  title: Text(40),
  pluginTitle: Schema.optional(Text(96)),
  icon: Schema.optional(PluginViewIconSchema),
  /** The tab id that draws the main area. */
  view: Schema.optional(ViewId),
  chat: Schema.optional(Schema.Literals(["side", "hidden"])),
  available: Schema.Boolean,
});

export type PluginThreadTypeEntry = typeof PluginThreadTypeEntry.Type;

/** A Thread type the caller may start. */
export const PluginThreadTypeOption = Schema.Struct({
  /** `<plugin>/<type>`, as `POST /v1/threads` takes it. */
  ref: Text(130),
  plugin: Text(96),
  type: ViewId,
  title: Text(40),
  pluginTitle: Text(96),
  icon: Schema.optional(PluginViewIconSchema),
  chat: Schema.Literals(["side", "hidden"]),
});

export type PluginThreadTypeOption = typeof PluginThreadTypeOption.Type;

/**
 * `GET /v1/plugins/views`: the caller's Thread types and views, from their
 * installs' manifests only (no plugin code runs). Private, cached briefly.
 */
export const PluginViewsCatalogResponseSchema = successResponse(
  Schema.Struct({
    threadTypes: Schema.Array(PluginThreadTypeOption),
    /** Views described as data; absent from older servers. */
    dataViews: Schema.optional(Schema.Array(PluginDataViewOption)),
  }),
);

export type PluginViewsCatalog =
  (typeof PluginViewsCatalogResponseSchema.Type)["data"];

export const PluginViewsErrorCodes = ["INVALID_REQUEST"] as const;

export type PluginViewsErrorCode = (typeof PluginViewsErrorCodes)[number];

export const PluginViewsErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literals(PluginViewsErrorCodes),
    message: Schema.String,
    requestId: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
});
