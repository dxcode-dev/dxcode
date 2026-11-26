import { PluginId, WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  PluginBundleFileResponseSchema,
  PluginBundleFilesResponseSchema,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleRejectedResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PreviewPluginBundleFilesRequestSchema,
  PreviewPluginBundleUpdateResponseSchema,
  SavePluginBundleFilesRequestSchema,
  UpdatePluginBundleSourceResponseSchema,
} from "./plugin-bundles.js";

/**
 * An installed plugin's files on the Plugins page: the tree when a plugin is
 * chosen, one file when it is opened, and edited files previewed and saved
 * as the plugin's next version. In their own module, so code that imports
 * only the schemas does not carry them (wiki/headless-client.md).
 */

const refusals = [
  { status: 400, schema: PluginBundleRejectedResponseSchema },
  { status: 403, schema: PluginBundlesForbiddenResponseSchema },
  { status: 404, schema: PluginBundleNotFoundResponseSchema },
  { status: 503, schema: PluginBundlesUnavailableResponseSchema },
];

/** Saving also refuses a version that changed since it was previewed. */
const saveRefusals = [
  ...refusals,
  { status: 409, schema: PluginBundleIntegrityConflictResponseSchema },
];

const PersonalPath = "/v1/settings/personal/plugin-bundles/:pluginId/files";
const WorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/plugin-bundles/:pluginId/files";

const PersonalParamsSchema = Schema.Struct({ pluginId: PluginId });
const WorkspaceParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
  pluginId: PluginId,
});

/** The file to read, by its path in the plugin. */
const FileQuerySchema = Schema.Struct({ path: Schema.String });

export const ListPersonalPluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.personal.list",
  method: "GET",
  path: PersonalPath,
  params: PersonalParamsSchema,
  success: PluginBundleFilesResponseSchema,
  refusals,
});

export const ReadPersonalPluginFileEndpoint = defineEndpoint({
  id: "pluginFiles.personal.read",
  method: "GET",
  path: `${PersonalPath}/content`,
  params: PersonalParamsSchema,
  query: FileQuerySchema,
  success: PluginBundleFileResponseSchema,
  refusals,
});

export const PreviewPersonalPluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.personal.preview",
  method: "POST",
  path: `${PersonalPath}/preview`,
  params: PersonalParamsSchema,
  body: PreviewPluginBundleFilesRequestSchema,
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals,
});

export const SavePersonalPluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.personal.save",
  method: "POST",
  path: PersonalPath,
  params: PersonalParamsSchema,
  body: SavePluginBundleFilesRequestSchema,
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: saveRefusals,
});

export const ListWorkspacePluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.workspace.list",
  method: "GET",
  path: WorkspacePath,
  params: WorkspaceParamsSchema,
  success: PluginBundleFilesResponseSchema,
  refusals,
});

export const ReadWorkspacePluginFileEndpoint = defineEndpoint({
  id: "pluginFiles.workspace.read",
  method: "GET",
  path: `${WorkspacePath}/content`,
  params: WorkspaceParamsSchema,
  query: FileQuerySchema,
  success: PluginBundleFileResponseSchema,
  refusals,
});

export const PreviewWorkspacePluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.workspace.preview",
  method: "POST",
  path: `${WorkspacePath}/preview`,
  params: WorkspaceParamsSchema,
  body: PreviewPluginBundleFilesRequestSchema,
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals,
});

export const SaveWorkspacePluginFilesEndpoint = defineEndpoint({
  id: "pluginFiles.workspace.save",
  method: "POST",
  path: WorkspacePath,
  params: WorkspaceParamsSchema,
  body: SavePluginBundleFilesRequestSchema,
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: saveRefusals,
});
