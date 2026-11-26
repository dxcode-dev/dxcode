import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * A plugin's own web app: served by its program on its plugin Orb and
 * drawn in a frame under a dx header at `/plugins/<name>/app`, for a custom
 * canvas or live media that a view described as data cannot draw.
 */

export const PluginAppEntry = Schema.Struct({
  plugin: Schema.String,
  title: Schema.String,
  /** `lucide:<name>` or an icon asset's sha256. */
  icon: Schema.optional(Schema.String),
});

export type PluginAppEntry = typeof PluginAppEntry.Type;

export const PluginAppsResponseSchema = successResponse(
  Schema.Struct({ apps: Schema.Array(PluginAppEntry) }),
);

/** Where the frame loads the app now; offered for a few minutes. */
export const PluginAppUrlResponseSchema = successResponse(
  Schema.Struct({
    url: Schema.String,
    expiresAt: Schema.Number,
    title: Schema.String,
    icon: Schema.optional(Schema.String),
  }),
);

export const PluginAppErrorCodes = [
  "PLUGIN_APP_NOT_FOUND",
  "PLUGIN_APP_UNAVAILABLE",
] as const;

export const PluginAppErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literals(PluginAppErrorCodes),
    message: Schema.String,
    requestId: Schema.String,
  }),
});
