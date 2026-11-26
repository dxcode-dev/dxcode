import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import {
  PluginOrbResponseSchema,
  UpdatePluginOrbRequestSchema,
} from "./plugin-orb.js";

/**
 * Where plugins' programs run (`plugin-orb.ts`): a person's choice, a
 * workspace's, and one plugin's own. In their own module, so code that
 * imports only the schemas does not carry them (wiki/headless-client.md).
 */

const pluginOrbRefusals = [
  {
    status: 400,
    schema: errorResponse("INVALID_REQUEST", "Choose an Orb size, or none."),
  },
  {
    status: 403,
    schema: errorResponse(
      "FORBIDDEN",
      "Only the workspace's admins can choose where its plugins run.",
    ),
  },
  { status: 404, schema: errorResponse("NOT_FOUND", "Not found.") },
  {
    status: 503,
    schema: errorResponse(
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
    ),
  },
];

const PersonalPath = "/v1/settings/personal/plugin-orb";
const WorkspacePath = "/v1/settings/workspaces/:workspaceSlug/plugin-orb";
const PluginPath = "/v1/settings/plugin-orb/plugins/:pluginId";

const WorkspaceParamsSchema = Schema.Struct({ workspaceSlug: WorkspaceSlug });
const PluginParamsSchema = Schema.Struct({ pluginId: Schema.String });

export const GetPersonalPluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.personal.get",
  method: "GET",
  path: PersonalPath,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});

export const UpdatePersonalPluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.personal.update",
  method: "PUT",
  path: PersonalPath,
  body: UpdatePluginOrbRequestSchema,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});

export const GetWorkspacePluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.workspace.get",
  method: "GET",
  path: WorkspacePath,
  params: WorkspaceParamsSchema,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});

export const UpdateWorkspacePluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.workspace.update",
  method: "PUT",
  path: WorkspacePath,
  params: WorkspaceParamsSchema,
  body: UpdatePluginOrbRequestSchema,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});

export const GetPluginPluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.plugin.get",
  method: "GET",
  path: PluginPath,
  params: PluginParamsSchema,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});

export const UpdatePluginPluginOrbEndpoint = defineEndpoint({
  id: "pluginOrb.plugin.update",
  method: "PUT",
  path: PluginPath,
  params: PluginParamsSchema,
  body: UpdatePluginOrbRequestSchema,
  success: PluginOrbResponseSchema,
  refusals: pluginOrbRefusals,
});
