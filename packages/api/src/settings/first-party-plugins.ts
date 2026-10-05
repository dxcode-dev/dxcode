import {
  FirstPartyPluginId,
  PluginCapabilityId,
  PluginCredential,
  PluginEnablement,
  PluginProviderId,
  PluginResolution,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Providers a plugin lists (never `fixture`). Only providers with a
 * credential label can be configured by a person or workspace; QuickJS, E2B,
 * Cloudflare Containers, and the local runtime cannot.
 */
export const ConfigurablePluginProviderId = Schema.Literals([
  "exa",
  "quickjs",
  "sarvam",
  "e2b",
  "cloudflare",
  "local",
]);

export const FirstPartyPluginProviderDataSchema = Schema.Struct({
  id: ConfigurablePluginProviderId,
  displayName: Schema.String,
  capabilities: Schema.Array(PluginCapabilityId),
  credentialLabel: Schema.NullOr(Schema.String),
});

/** A stored configuration; the credential itself is never returned. */
export const FirstPartyPluginConfigurationDataSchema = Schema.Struct({
  providerId: ConfigurablePluginProviderId,
  configuredAt: Schema.String,
});

export const FirstPartyPluginDataSchema = Schema.Struct({
  id: FirstPartyPluginId,
  displayName: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(PluginCapabilityId),
  /** Always installed and never disabled; only the provider can change. */
  alwaysOn: Schema.Boolean,
  providers: Schema.Array(FirstPartyPluginProviderDataSchema),
  /** This scope's own values. `null` enablement means unset. */
  enablement: Schema.NullOr(PluginEnablement),
  configuration: Schema.NullOr(FirstPartyPluginConfigurationDataSchema),
  /** Values this scope inherits. `workspace` is present only for members viewing personal settings. */
  inherited: Schema.Struct({
    workspace: Schema.NullOr(
      Schema.Struct({
        enablement: Schema.NullOr(PluginEnablement),
        providerId: Schema.NullOr(ConfigurablePluginProviderId),
      }),
    ),
    deployment: Schema.Struct({
      providerId: Schema.NullOr(PluginProviderId),
    }),
  }),
  /** Personal: the viewer's effective result. Workspace: a member with no personal settings. */
  effective: PluginResolution,
  personalOverridesAllowed: Schema.Boolean,
});

export type FirstPartyPluginData = typeof FirstPartyPluginDataSchema.Type;

export const FirstPartyPluginListDataSchema = Schema.Struct({
  scope: Schema.Literals(["personal", "workspace"]),
  canUpdate: Schema.Boolean,
  plugins: Schema.Array(FirstPartyPluginDataSchema),
});

export type FirstPartyPluginListData =
  typeof FirstPartyPluginListDataSchema.Type;

export const FirstPartyPluginListResponseSchema = successResponse(
  FirstPartyPluginListDataSchema,
);

export const WorkspaceFirstPartyPluginParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const FirstPartyPluginParamsSchema = Schema.Struct({
  pluginId: FirstPartyPluginId,
});

export const SetFirstPartyPluginEnablementRequestSchema = Schema.Struct({
  enablement: Schema.NullOr(PluginEnablement),
});

export const SetFirstPartyPluginConfigurationRequestSchema = Schema.Struct({
  providerId: ConfigurablePluginProviderId,
  credential: PluginCredential,
});

export const SetFirstPartyPluginPolicyRequestSchema = Schema.Struct({
  allowPersonalOverrides: Schema.Boolean,
});

export type SetFirstPartyPluginConfigurationRequest =
  typeof SetFirstPartyPluginConfigurationRequestSchema.Type;

export const FirstPartyPluginInvalidRequestResponseSchema = errorResponse(
  "INVALID_PLUGIN_REQUEST",
  "Plugin settings request is invalid.",
);

export const FirstPartyPluginNotInstalledResponseSchema = errorResponse(
  "PLUGIN_NOT_INSTALLED",
  "This plugin is not installed on this deployment.",
);

export const FirstPartyPluginForbiddenResponseSchema = errorResponse(
  "PLUGIN_SETTINGS_FORBIDDEN",
  "This plugin settings action is not permitted.",
);

export const FirstPartyPluginPersonalOverrideDeniedResponseSchema =
  errorResponse(
    "PLUGIN_PERSONAL_OVERRIDE_DENIED",
    "Your workspace decides this plugin's configuration.",
  );

export const FirstPartyPluginUnavailableResponseSchema = errorResponse(
  "PLUGIN_SETTINGS_UNAVAILABLE",
  "Plugin settings are temporarily unavailable.",
);

export const FirstPartyPluginErrorResponseSchema = Schema.Union([
  FirstPartyPluginInvalidRequestResponseSchema,
  FirstPartyPluginNotInstalledResponseSchema,
  FirstPartyPluginForbiddenResponseSchema,
  FirstPartyPluginPersonalOverrideDeniedResponseSchema,
  FirstPartyPluginUnavailableResponseSchema,
]);
