import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  FirstPartyPluginForbiddenResponseSchema,
  FirstPartyPluginInvalidRequestResponseSchema,
  FirstPartyPluginListResponseSchema,
  FirstPartyPluginNotInstalledResponseSchema,
  FirstPartyPluginParamsSchema,
  FirstPartyPluginPersonalOverrideDeniedResponseSchema,
  FirstPartyPluginUnavailableResponseSchema,
  SetFirstPartyPluginConfigurationRequestSchema,
  SetFirstPartyPluginEnablementRequestSchema,
  SetFirstPartyPluginPolicyRequestSchema,
  WorkspaceFirstPartyPluginParamsSchema,
} from "./first-party-plugins.js";

/**
 * The endpoints over `first-party-plugins.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const firstPartyPluginRefusals = [
  { status: 400, schema: FirstPartyPluginInvalidRequestResponseSchema },
  { status: 404, schema: FirstPartyPluginNotInstalledResponseSchema },
  { status: 403, schema: FirstPartyPluginForbiddenResponseSchema },
  {
    status: 403,
    schema: FirstPartyPluginPersonalOverrideDeniedResponseSchema,
  },
  { status: 503, schema: FirstPartyPluginUnavailableResponseSchema },
];

const FirstPartyPluginsPersonalPath =
  "/v1/settings/personal/first-party-plugins";
const FirstPartyPluginsWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/first-party-plugins";

export const ListPersonalFirstPartyPluginsEndpoint = defineEndpoint({
  id: "firstPartyPlugins.personal.list",
  method: "GET",
  path: `${FirstPartyPluginsPersonalPath}`,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});

export const ListWorkspaceFirstPartyPluginsEndpoint = defineEndpoint({
  id: "firstPartyPlugins.workspace.list",
  method: "GET",
  path: `${FirstPartyPluginsWorkspacePath}`,
  params: WorkspaceFirstPartyPluginParamsSchema,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});

export const SetPersonalFirstPartyPluginEnablementEndpoint = defineEndpoint({
  id: "firstPartyPlugins.personal.setEnablement",
  method: "PUT",
  path: `${FirstPartyPluginsPersonalPath}/:pluginId/enablement`,
  params: FirstPartyPluginParamsSchema,
  body: SetFirstPartyPluginEnablementRequestSchema,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});

export const SetWorkspaceFirstPartyPluginEnablementEndpoint = defineEndpoint({
  id: "firstPartyPlugins.workspace.setEnablement",
  method: "PUT",
  path: `${FirstPartyPluginsWorkspacePath}/:pluginId/enablement`,
  params: Schema.Struct({
    ...WorkspaceFirstPartyPluginParamsSchema.fields,
    ...FirstPartyPluginParamsSchema.fields,
  }),
  body: SetFirstPartyPluginEnablementRequestSchema,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});

export const SetPersonalFirstPartyPluginConfigurationEndpoint = defineEndpoint({
  id: "firstPartyPlugins.personal.setConfiguration",
  method: "PUT",
  path: `${FirstPartyPluginsPersonalPath}/:pluginId/configuration`,
  params: FirstPartyPluginParamsSchema,
  body: SetFirstPartyPluginConfigurationRequestSchema,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});

export const SetWorkspaceFirstPartyPluginConfigurationEndpoint = defineEndpoint(
  {
    id: "firstPartyPlugins.workspace.setConfiguration",
    method: "PUT",
    path: `${FirstPartyPluginsWorkspacePath}/:pluginId/configuration`,
    params: Schema.Struct({
      ...WorkspaceFirstPartyPluginParamsSchema.fields,
      ...FirstPartyPluginParamsSchema.fields,
    }),
    body: SetFirstPartyPluginConfigurationRequestSchema,
    success: FirstPartyPluginListResponseSchema,
    refusals: firstPartyPluginRefusals,
  },
);

export const DeletePersonalFirstPartyPluginConfigurationEndpoint =
  defineEndpoint({
    id: "firstPartyPlugins.personal.deleteConfiguration",
    method: "DELETE",
    path: `${FirstPartyPluginsPersonalPath}/:pluginId/configuration`,
    params: FirstPartyPluginParamsSchema,
    success: FirstPartyPluginListResponseSchema,
    refusals: firstPartyPluginRefusals,
  });

export const DeleteWorkspaceFirstPartyPluginConfigurationEndpoint =
  defineEndpoint({
    id: "firstPartyPlugins.workspace.deleteConfiguration",
    method: "DELETE",
    path: `${FirstPartyPluginsWorkspacePath}/:pluginId/configuration`,
    params: Schema.Struct({
      ...WorkspaceFirstPartyPluginParamsSchema.fields,
      ...FirstPartyPluginParamsSchema.fields,
    }),
    success: FirstPartyPluginListResponseSchema,
    refusals: firstPartyPluginRefusals,
  });

export const SetWorkspaceFirstPartyPluginPolicyEndpoint = defineEndpoint({
  id: "firstPartyPlugins.workspace.setPolicy",
  method: "PUT",
  path: `${FirstPartyPluginsWorkspacePath}/policy`,
  params: WorkspaceFirstPartyPluginParamsSchema,
  body: SetFirstPartyPluginPolicyRequestSchema,
  success: FirstPartyPluginListResponseSchema,
  refusals: firstPartyPluginRefusals,
});
