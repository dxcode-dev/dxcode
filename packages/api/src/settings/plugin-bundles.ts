import {
  McpServerEndpoint,
  McpServerId,
  PluginBundleManifest,
  PluginBundleSkipped,
  PluginBundleSource,
  PluginId,
  PluginIntegrity,
  SkillId,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A skill a plugin bundle installed into the Skills store. */
export const PluginBundleSkillDataSchema = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  enabled: Schema.Boolean,
});

/** An MCP server a plugin bundle installed into the MCP server store. */
export const PluginBundleMcpServerDataSchema = Schema.Struct({
  id: McpServerId,
  name: Schema.String,
  endpoint: McpServerEndpoint,
  /** Whether at least one of its tools is discovered and approved. */
  reviewed: Schema.Boolean,
});

export const PluginBundleDataSchema = Schema.Struct({
  id: PluginId,
  scope: Schema.Literals(["personal", "workspace"]),
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  version: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  skills: Schema.Array(PluginBundleSkillDataSchema),
  mcpServers: Schema.Array(PluginBundleMcpServerDataSchema),
  skipped: Schema.Array(PluginBundleSkipped),
  installedAt: Timestamp,
  updatedAt: Timestamp,
});

export type PluginBundleData = typeof PluginBundleDataSchema.Type;

export const ListPluginBundlesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(PluginBundleDataSchema),
    canMutate: Schema.Boolean,
  }),
);

export type PluginBundleListData =
  typeof ListPluginBundlesResponseSchema.Type.data;

export const PluginBundlePreviewDataSchema = Schema.Struct({
  manifest: PluginBundleManifest,
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  /** Reasons the bundle cannot be installed in this scope. */
  conflicts: Schema.Array(Schema.String),
});

export type PluginBundlePreviewData = typeof PluginBundlePreviewDataSchema.Type;

export const PreviewPluginBundleResponseSchema = successResponse(
  PluginBundlePreviewDataSchema,
);

export const PluginBundleChangeSchema = Schema.Literals([
  "added",
  "changed",
  "removed",
  "unchanged",
]);

/** A new version of an installed bundle and what installing it changes. */
export const PluginBundleUpdatePreviewDataSchema = Schema.Struct({
  ...PluginBundlePreviewDataSchema.fields,
  upToDate: Schema.Boolean,
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, change: PluginBundleChangeSchema }),
  ),
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      endpoint: Schema.String,
      change: PluginBundleChangeSchema,
      /** The server moves to another origin, so its secrets are deleted. */
      credentialsCleared: Schema.Boolean,
    }),
  ),
});

export type PluginBundleUpdatePreviewData =
  typeof PluginBundleUpdatePreviewDataSchema.Type;

export const PreviewPluginBundleUpdateResponseSchema = successResponse(
  PluginBundleUpdatePreviewDataSchema,
);

export const UpdatePluginBundleSourceResponseSchema = successResponse(
  PluginBundleDataSchema,
);

export const InstallPluginBundleResponseSchema = successResponse(
  PluginBundleDataSchema,
);

export const PluginBundleParamsSchema = Schema.Struct({ pluginId: PluginId });

export const UpdatePluginBundleRequestSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

export const UpdatePluginBundleResponseSchema = successResponse(
  PluginBundleDataSchema,
);

export const RemovePluginBundleResponseSchema = successResponse(
  Schema.Struct({ removedPluginId: PluginId }),
);

/** The bundle or request was refused; `message` says why. */
export const PluginBundleRejectedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("PLUGIN_BUNDLE_REJECTED"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const PluginBundleSourceUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("PLUGIN_BUNDLE_SOURCE_UNAVAILABLE"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const PluginBundlesForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PluginBundleNotFoundResponseSchema = errorResponse(
  "PLUGIN_NOT_FOUND",
  "Plugin not found.",
);

export const PluginBundleIntegrityConflictResponseSchema = errorResponse(
  "PLUGIN_INTEGRITY_CONFLICT",
  "The plugin changed since you reviewed it. Preview it again.",
);

export const PluginBundlesUnavailableResponseSchema = errorResponse(
  "PLUGINS_UNAVAILABLE",
  "Plugins are temporarily unavailable.",
);

export const PluginBundlesErrorResponseSchema = Schema.Union([
  PluginBundleRejectedResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundlesUnavailableResponseSchema,
]);
