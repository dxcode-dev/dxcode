import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { pluginBundleRefusals } from "./plugin-bundle-endpoints.js";
import {
  PluginCatalogNotFoundResponseSchema,
  PreviewPluginBundleResponseSchema,
} from "./plugin-bundles.js";
import {
  AddPluginCatalogRequestSchema,
  AddPluginCatalogResponseSchema,
  ListPluginCatalogsResponseSchema,
  PluginCatalogParamsSchema,
  PreviewPluginCatalogEntryRequestSchema,
  RefreshPluginCatalogResponseSchema,
  RemovePluginCatalogResponseSchema,
} from "./plugin-catalogs.js";

/**
 * The endpoints over `plugin-catalogs.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const pluginCatalogRefusals = [
  ...pluginBundleRefusals,
  { status: 404, schema: PluginCatalogNotFoundResponseSchema },
];

const PluginCatalogsPersonalPath = "/v1/settings/personal/plugin-catalogs";
const PluginCatalogsWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/plugin-catalogs";

export const WorkspacePluginCatalogsParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

/** `refresh` takes an empty JSON object. */
export const PluginCatalogEmptyRequestSchema = Schema.Struct({});

export const ListPersonalPluginCatalogsEndpoint = defineEndpoint({
  id: "pluginCatalogs.personal.list",
  method: "GET",
  path: `${PluginCatalogsPersonalPath}`,
  success: ListPluginCatalogsResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const ListWorkspacePluginCatalogsEndpoint = defineEndpoint({
  id: "pluginCatalogs.workspace.list",
  method: "GET",
  path: `${PluginCatalogsWorkspacePath}`,
  params: WorkspacePluginCatalogsParamsSchema,
  success: ListPluginCatalogsResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const AddPersonalPluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.personal.add",
  method: "POST",
  path: `${PluginCatalogsPersonalPath}`,
  body: AddPluginCatalogRequestSchema,
  success: AddPluginCatalogResponseSchema,
  successStatus: 201,
  refusals: pluginCatalogRefusals,
});

export const AddWorkspacePluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.workspace.add",
  method: "POST",
  path: `${PluginCatalogsWorkspacePath}`,
  params: WorkspacePluginCatalogsParamsSchema,
  body: AddPluginCatalogRequestSchema,
  success: AddPluginCatalogResponseSchema,
  successStatus: 201,
  refusals: pluginCatalogRefusals,
});

export const RefreshPersonalPluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.personal.refresh",
  method: "POST",
  path: `${PluginCatalogsPersonalPath}/:catalogId/refresh`,
  params: PluginCatalogParamsSchema,
  body: PluginCatalogEmptyRequestSchema,
  success: RefreshPluginCatalogResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const RefreshWorkspacePluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.workspace.refresh",
  method: "POST",
  path: `${PluginCatalogsWorkspacePath}/:catalogId/refresh`,
  params: Schema.Struct({
    ...WorkspacePluginCatalogsParamsSchema.fields,
    ...PluginCatalogParamsSchema.fields,
  }),
  body: PluginCatalogEmptyRequestSchema,
  success: RefreshPluginCatalogResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const PreviewPersonalPluginCatalogEntryEndpoint = defineEndpoint({
  id: "pluginCatalogs.personal.previewEntry",
  method: "POST",
  path: `${PluginCatalogsPersonalPath}/:catalogId/entries/preview`,
  params: PluginCatalogParamsSchema,
  body: PreviewPluginCatalogEntryRequestSchema,
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const PreviewWorkspacePluginCatalogEntryEndpoint = defineEndpoint({
  id: "pluginCatalogs.workspace.previewEntry",
  method: "POST",
  path: `${PluginCatalogsWorkspacePath}/:catalogId/entries/preview`,
  params: Schema.Struct({
    ...WorkspacePluginCatalogsParamsSchema.fields,
    ...PluginCatalogParamsSchema.fields,
  }),
  body: PreviewPluginCatalogEntryRequestSchema,
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const RemovePersonalPluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.personal.remove",
  method: "DELETE",
  path: `${PluginCatalogsPersonalPath}/:catalogId`,
  params: PluginCatalogParamsSchema,
  success: RemovePluginCatalogResponseSchema,
  refusals: pluginCatalogRefusals,
});

export const RemoveWorkspacePluginCatalogEndpoint = defineEndpoint({
  id: "pluginCatalogs.workspace.remove",
  method: "DELETE",
  path: `${PluginCatalogsWorkspacePath}/:catalogId`,
  params: Schema.Struct({
    ...WorkspacePluginCatalogsParamsSchema.fields,
    ...PluginCatalogParamsSchema.fields,
  }),
  success: RemovePluginCatalogResponseSchema,
  refusals: pluginCatalogRefusals,
});
