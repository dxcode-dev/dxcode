import {
  PluginGrantedPermissions,
  PluginId,
  PluginImportBundle,
  PluginIntegrity,
  PluginManifest,
  PluginSource,
  PluginVersion,
  Timestamp,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const PluginFileDataSchema = Schema.Struct({
  path: Schema.String,
  mediaType: Schema.String,
  sizeBytes: Schema.Int,
  integrity: PluginIntegrity,
});

export type PluginFileData = typeof PluginFileDataSchema.Type;

export const PluginVersionDataSchema = Schema.Struct({
  version: PluginVersion,
  manifest: PluginManifest,
  files: Schema.Array(PluginFileDataSchema),
  source: PluginSource,
  integrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
  trusted: Schema.Literal(true),
  trustedAt: Timestamp,
});

export type PluginVersionData = typeof PluginVersionDataSchema.Type;

export const PluginEffectiveStateSchema = Schema.Literals([
  "disabled",
  "effective",
  "blocked-by-workspace",
  "blocked-by-policy",
]);

export const PluginDataSchema = Schema.Struct({
  id: PluginId,
  scope: Schema.Literals(["personal", "workspace"]),
  name: Schema.String,
  enabled: Schema.Boolean,
  activeVersion: PluginVersion,
  versions: Schema.Array(PluginVersion),
  active: PluginVersionDataSchema,
  healthStatus: Schema.Literals(["unchecked", "healthy", "unhealthy"]),
  effectiveState: PluginEffectiveStateSchema,
  overridesPersonal: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type PluginData = typeof PluginDataSchema.Type;

export const ListPluginsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(PluginDataSchema),
    canMutate: Schema.Boolean,
    precedence: Schema.Literal("workspace-over-personal"),
    allowPersonalPlugins: Schema.optional(Schema.Boolean),
  }),
);

export const PreviewPluginRequestSchema = PluginImportBundle;

export const PreviewPluginResponseSchema = successResponse(
  Schema.Struct({
    manifest: PluginManifest,
    files: Schema.Array(PluginFileDataSchema),
    source: PluginSource,
    integrity: PluginIntegrity,
    totalBytes: Schema.Int,
  }),
);

export const TrustPluginRequestSchema = Schema.Struct({
  bundle: PluginImportBundle,
  reviewedIntegrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
});

export const TrustPluginResponseSchema = successResponse(PluginDataSchema);

export const PluginParamsSchema = Schema.Struct({ pluginId: PluginId });

export const PublishPluginVersionRequestSchema = Schema.Struct({
  bundle: PluginImportBundle,
  reviewedIntegrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
  activate: Schema.Boolean,
});

export const PublishPluginVersionResponseSchema =
  successResponse(PluginDataSchema);

export const UpdatePluginStateRequestSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  activeVersion: Schema.optional(PluginVersion),
});

export const UpdatePluginStateResponseSchema =
  successResponse(PluginDataSchema);

export const RemovePluginResponseSchema = successResponse(
  Schema.Struct({ removedPluginId: PluginId }),
);

export const UpdatePluginWorkspacePolicyRequestSchema = Schema.Struct({
  allowPersonalPlugins: Schema.Boolean,
});

export const UpdatePluginWorkspacePolicyResponseSchema = successResponse(
  Schema.Struct({ allowPersonalPlugins: Schema.Boolean }),
);

export const PluginsInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_PLUGIN_REQUEST"),
    message: Schema.Literal("Plugin validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const PluginsForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PluginsBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required to trust plugins.",
);

export const PluginNotFoundResponseSchema = errorResponse(
  "PLUGIN_NOT_FOUND",
  "Plugin not found.",
);

export const PluginLimitResponseSchema = errorResponse(
  "PLUGIN_LIMIT_EXCEEDED",
  "This scope has reached its plugin limit.",
);

export const PluginIntegrityConflictResponseSchema = errorResponse(
  "PLUGIN_INTEGRITY_CONFLICT",
  "The reviewed plugin content no longer matches or conflicts with an immutable version.",
);

export const PluginPermissionInvalidResponseSchema = errorResponse(
  "PLUGIN_PERMISSION_INVALID",
  "Every granted permission must be explicitly requested and reference an approved resource.",
);

export const PluginsPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal(
      "Workspace policy does not allow this personal plugin permission.",
    ),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export const PluginsUnavailableResponseSchema = errorResponse(
  "PLUGINS_UNAVAILABLE",
  "Plugins are temporarily unavailable.",
);

export const PluginsErrorResponseSchema = Schema.Union([
  PluginsInvalidRequestResponseSchema,
  PluginsForbiddenResponseSchema,
  PluginNotFoundResponseSchema,
  PluginLimitResponseSchema,
  PluginIntegrityConflictResponseSchema,
  PluginPermissionInvalidResponseSchema,
  PluginsPolicyDeniedResponseSchema,
  PluginsBrowserSessionRequiredResponseSchema,
  PluginsUnavailableResponseSchema,
]);
