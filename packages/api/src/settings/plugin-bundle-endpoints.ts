import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  ApprovePluginProposalRequestSchema,
  CreatePluginShareLinkResponseSchema,
  DecidePluginProposalResponseSchema,
  ListPluginBundlesResponseSchema,
  ListPluginBundleUpdatesResponseSchema,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleParamsSchema,
  PluginBundleRejectedResponseSchema,
  PluginBundleSettingsResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PluginProposalDecidedResponseSchema,
  PluginProposalParamsSchema,
  RemovePluginBundleResponseSchema,
  RevokePluginShareLinksResponseSchema,
  SetPluginBundlePolicyRequestSchema,
  UpdatePluginBundleRequestSchema,
  UpdatePluginBundleResponseSchema,
  UpdatePluginBundleSettingsRequestSchema,
} from "./plugin-bundles.js";
import { PluginHostUsageResponseSchema } from "./plugin-host-usage.js";

/**
 * Plugin bundle endpoints. Apart from `plugin-bundles.ts`, whose schemas the
 * Thread page loads on first load, so these definitions stay off it.
 */

/** What every plugin bundle and catalog route refuses, with Core's status. */
export const pluginBundleRefusals = [
  { status: 400, schema: PluginBundleRejectedResponseSchema },
  { status: 502, schema: PluginBundleSourceUnavailableResponseSchema },
  { status: 403, schema: PluginBundlesForbiddenResponseSchema },
  { status: 404, schema: PluginBundleNotFoundResponseSchema },
  { status: 409, schema: PluginProposalDecidedResponseSchema },
  { status: 409, schema: PluginBundleIntegrityConflictResponseSchema },
  { status: 503, schema: PluginBundlesUnavailableResponseSchema },
];

const PluginBundlesPersonalPath = "/v1/settings/personal/plugin-bundles";
const PluginBundlesWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/plugin-bundles";

export const WorkspacePluginBundlesParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const ListPersonalPluginBundlesEndpoint = defineEndpoint({
  id: "pluginBundles.personal.list",
  method: "GET",
  path: `${PluginBundlesPersonalPath}`,
  success: ListPluginBundlesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const ListWorkspacePluginBundlesEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.list",
  method: "GET",
  path: `${PluginBundlesWorkspacePath}`,
  params: WorkspacePluginBundlesParamsSchema,
  success: ListPluginBundlesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetPersonalPluginBundlePolicyEndpoint = defineEndpoint({
  id: "pluginBundles.personal.setPolicy",
  method: "PUT",
  path: `${PluginBundlesPersonalPath}/policy`,
  body: SetPluginBundlePolicyRequestSchema,
  success: ListPluginBundlesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetWorkspacePluginBundlePolicyEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.setPolicy",
  method: "PUT",
  path: `${PluginBundlesWorkspacePath}/policy`,
  params: WorkspacePluginBundlesParamsSchema,
  body: SetPluginBundlePolicyRequestSchema,
  success: ListPluginBundlesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const ListPersonalPluginBundleUpdatesEndpoint = defineEndpoint({
  id: "pluginBundles.personal.listUpdates",
  method: "GET",
  path: `${PluginBundlesPersonalPath}/updates`,
  success: ListPluginBundleUpdatesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const ListWorkspacePluginBundleUpdatesEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.listUpdates",
  method: "GET",
  path: `${PluginBundlesWorkspacePath}/updates`,
  params: WorkspacePluginBundlesParamsSchema,
  success: ListPluginBundleUpdatesResponseSchema,
  refusals: pluginBundleRefusals,
});

export const GetPersonalPluginBundleSettingsEndpoint = defineEndpoint({
  id: "pluginBundles.personal.getSettings",
  method: "GET",
  path: `${PluginBundlesPersonalPath}/:pluginId/settings`,
  params: PluginBundleParamsSchema,
  success: PluginBundleSettingsResponseSchema,
  refusals: pluginBundleRefusals,
});

export const GetWorkspacePluginBundleSettingsEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.getSettings",
  method: "GET",
  path: `${PluginBundlesWorkspacePath}/:pluginId/settings`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  success: PluginBundleSettingsResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetPersonalPluginBundleSettingsEndpoint = defineEndpoint({
  id: "pluginBundles.personal.setSettings",
  method: "PUT",
  path: `${PluginBundlesPersonalPath}/:pluginId/settings`,
  params: PluginBundleParamsSchema,
  body: UpdatePluginBundleSettingsRequestSchema,
  success: PluginBundleSettingsResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetWorkspacePluginBundleSettingsEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.setSettings",
  method: "PUT",
  path: `${PluginBundlesWorkspacePath}/:pluginId/settings`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  body: UpdatePluginBundleSettingsRequestSchema,
  success: PluginBundleSettingsResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetPersonalPluginBundleEnabledEndpoint = defineEndpoint({
  id: "pluginBundles.personal.setEnabled",
  method: "PATCH",
  path: `${PluginBundlesPersonalPath}/:pluginId`,
  params: PluginBundleParamsSchema,
  body: UpdatePluginBundleRequestSchema,
  success: UpdatePluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const SetWorkspacePluginBundleEnabledEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.setEnabled",
  method: "PATCH",
  path: `${PluginBundlesWorkspacePath}/:pluginId`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  body: UpdatePluginBundleRequestSchema,
  success: UpdatePluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const RemovePersonalPluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.personal.remove",
  method: "DELETE",
  path: `${PluginBundlesPersonalPath}/:pluginId`,
  params: PluginBundleParamsSchema,
  success: RemovePluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const RemoveWorkspacePluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.remove",
  method: "DELETE",
  path: `${PluginBundlesWorkspacePath}/:pluginId`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  success: RemovePluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const GetPersonalPluginHostUsageEndpoint = defineEndpoint({
  id: "pluginBundles.personal.hostUsage",
  method: "GET",
  path: `${PluginBundlesPersonalPath}/:pluginId/host-usage`,
  params: PluginBundleParamsSchema,
  success: PluginHostUsageResponseSchema,
  refusals: pluginBundleRefusals,
});

export const GetWorkspacePluginHostUsageEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.hostUsage",
  method: "GET",
  path: `${PluginBundlesWorkspacePath}/:pluginId/host-usage`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  success: PluginHostUsageResponseSchema,
  refusals: pluginBundleRefusals,
});

/** Share links and rejections send an empty JSON object. */
export const PluginBundleEmptyRequestSchema = Schema.Struct({});

export const CreatePersonalPluginShareLinkEndpoint = defineEndpoint({
  id: "pluginBundles.personal.createShareLink",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/:pluginId/share`,
  params: PluginBundleParamsSchema,
  body: PluginBundleEmptyRequestSchema,
  success: CreatePluginShareLinkResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const CreateWorkspacePluginShareLinkEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.createShareLink",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/:pluginId/share`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  body: PluginBundleEmptyRequestSchema,
  success: CreatePluginShareLinkResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const RevokePersonalPluginShareLinksEndpoint = defineEndpoint({
  id: "pluginBundles.personal.revokeShareLinks",
  method: "DELETE",
  path: `${PluginBundlesPersonalPath}/:pluginId/share`,
  params: PluginBundleParamsSchema,
  success: RevokePluginShareLinksResponseSchema,
  refusals: pluginBundleRefusals,
});

export const RevokeWorkspacePluginShareLinksEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.revokeShareLinks",
  method: "DELETE",
  path: `${PluginBundlesWorkspacePath}/:pluginId/share`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  success: RevokePluginShareLinksResponseSchema,
  refusals: pluginBundleRefusals,
});

export const ApprovePersonalPluginProposalEndpoint = defineEndpoint({
  id: "pluginBundles.personal.approveProposal",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/proposals/:proposalId/approve`,
  params: PluginProposalParamsSchema,
  body: ApprovePluginProposalRequestSchema,
  success: DecidePluginProposalResponseSchema,
  refusals: pluginBundleRefusals,
});

export const ApproveWorkspacePluginProposalEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.approveProposal",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/proposals/:proposalId/approve`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginProposalParamsSchema.fields,
  }),
  body: ApprovePluginProposalRequestSchema,
  success: DecidePluginProposalResponseSchema,
  refusals: pluginBundleRefusals,
});

export const RejectPersonalPluginProposalEndpoint = defineEndpoint({
  id: "pluginBundles.personal.rejectProposal",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/proposals/:proposalId/reject`,
  params: PluginProposalParamsSchema,
  body: PluginBundleEmptyRequestSchema,
  success: DecidePluginProposalResponseSchema,
  refusals: pluginBundleRefusals,
});

export const RejectWorkspacePluginProposalEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.rejectProposal",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/proposals/:proposalId/reject`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginProposalParamsSchema.fields,
  }),
  body: PluginBundleEmptyRequestSchema,
  success: DecidePluginProposalResponseSchema,
  refusals: pluginBundleRefusals,
});

/** `?sign=1` adds plugin.sig, signed with the person's managed key. */
export const ExportPluginBundleQuerySchema = Schema.Struct({
  sign: Schema.optional(Schema.Literal("1")),
});

/** The plugin as a ZIP a browser downloads, or a link points at. */
export const ExportPersonalPluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.personal.export",
  method: "GET",
  path: `${PluginBundlesPersonalPath}/:pluginId/export`,
  params: PluginBundleParamsSchema,
  query: ExportPluginBundleQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: pluginBundleRefusals,
});

export const ExportWorkspacePluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.export",
  method: "GET",
  path: `${PluginBundlesWorkspacePath}/:pluginId/export`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  query: ExportPluginBundleQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: pluginBundleRefusals,
});
