import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Plugin views. Tabs show in a Thread beside Chat, Files, Changes, and
 * Terminal; pages are full pages outside any Thread, at
 * `/plugins/<name>/<id><path>`; a Thread type's tab draws a Thread's main
 * area with the chat beside it. Each needs the plugin's trusted tier: below
 * it dx leaves the view out rather than refusing the plugin.
 */

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const ViewId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/));

/** `lucide:<name>` or an icon asset's sha256 (per-item icon). */
export const PluginViewIconSchema = Schema.String.check(
  Schema.isPattern(/^(?:lucide:[a-z0-9-]{1,64}|[0-9a-f]{64})$/),
);

/** A tab an installed plugin offers in the Thread. */
export const PluginTabEntry = Schema.Struct({
  plugin: Text(96),
  /** The view id; tabs and panes share one tab kind in the layout. */
  tab: ViewId,
  title: Text(40),
  pluginTitle: Text(96),
  version: Text(200),
  icon: Schema.optional(PluginViewIconSchema),
  /** Shown in an archived Thread, read-only (`archivedThreads: show`). */
  readOnly: Schema.optional(Schema.Literal(true)),
});

export type PluginTabEntry = typeof PluginTabEntry.Type;

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

/** A page in the caller's views catalog. */
export const PluginPageEntry = Schema.Struct({
  plugin: Text(96),
  page: ViewId,
  title: Text(40),
  pluginTitle: Text(96),
  /** The page's default sub-path, `/` or `/dashboard`. */
  path: Schema.String.check(Schema.isMaxLength(200)),
  icon: Schema.optional(PluginViewIconSchema),
});

export type PluginPageEntry = typeof PluginPageEntry.Type;

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
 * `GET /v1/plugins/views`: the caller's pages and Thread types, from their
 * installs' manifests only (no plugin code runs). Private, cached briefly.
 */
export const PluginViewsCatalogResponseSchema = successResponse(
  Schema.Struct({
    pages: Schema.Array(PluginPageEntry),
    threadTypes: Schema.Array(PluginThreadTypeOption),
  }),
);

export type PluginViewsCatalog =
  (typeof PluginViewsCatalogResponseSchema.Type)["data"];

/** `GET /v1/plugins/views/:plugin/pages/:page`: the page's view. */
export const PluginPageViewResponseSchema = successResponse(
  Schema.Struct({
    html: Schema.String,
    version: Text(200),
    title: Text(40),
    pluginTitle: Text(96),
    icon: Schema.optional(PluginViewIconSchema),
    handlesMessages: Schema.Boolean,
  }),
);

export type PluginPageView = (typeof PluginPageViewResponseSchema.Type)["data"];

export const PluginViewsErrorCodes = [
  "INVALID_REQUEST",
  "PLUGIN_PAGE_NOT_FOUND",
  "PLUGIN_PAGE_FAILED",
] as const;

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
