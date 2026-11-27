import { PluginBundleSource, PluginIntegrity, WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  ApprovePluginProposalRequestSchema,
  CreatePluginShareLinkResponseSchema,
  DecidePluginProposalResponseSchema,
  InstallPluginBundleResponseSchema,
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
  PreviewPluginBundleResponseSchema,
  PreviewPluginBundleUpdateResponseSchema,
  RemovePluginBundleResponseSchema,
  RevokePluginShareLinksResponseSchema,
  SetPluginBundlePolicyRequestSchema,
  UpdatePluginBundleRequestSchema,
  UpdatePluginBundleResponseSchema,
  UpdatePluginBundleSettingsRequestSchema,
  UpdatePluginBundleSourceResponseSchema,
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

/** A plugin from GitHub by URL, or a share link's token, to preview. */
export const PreviewPluginBundleRequestSchema = Schema.Union([
  Schema.Struct({ url: Schema.String }),
  /** A share link's token. */
  Schema.Struct({ share: Schema.String }),
]);

/** Installs a share link's plugin as the person reviewed it. */
export const InstallSharedPluginBundleRequestSchema = Schema.Struct({
  share: Schema.String,
  reviewedIntegrity: PluginIntegrity,
});

/** Installs or updates from the previewed source, pinned to its commit. */
export const InstallPluginBundleSourceRequestSchema = Schema.Struct({
  source: PluginBundleSource,
  reviewedIntegrity: PluginIntegrity,
  /** An update only: the person accepted the wider grants it asks for. */
  acceptPermissions: Schema.optional(Schema.Boolean),
});

export const InstallPluginBundleRequestSchema = Schema.Union([
  InstallSharedPluginBundleRequestSchema,
  InstallPluginBundleSourceRequestSchema,
]);

/** A ZIP upload is the request body, named by `?name=`. */
export const PluginBundleZipPreviewQuerySchema = Schema.Struct({
  name: Schema.optional(Schema.String),
});

/**
 * Installing a ZIP repeats the upload with the integrity the person
 * reviewed; `acceptPermissions=1` accepts an update's wider grants.
 */
export const PluginBundleZipInstallQuerySchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  integrity: PluginIntegrity,
  acceptPermissions: Schema.optional(Schema.Literal("1")),
});

/*
 * Preview, install, update preview, and update each take JSON (a GitHub URL,
 * a share link, or a pinned source) or a ZIP's bytes on the same route, so
 * each route has a JSON endpoint and a `…Zip` one with `upload: "bytes"`.
 */

export const PreviewPersonalPluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.personal.preview",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/preview`,
  body: PreviewPluginBundleRequestSchema,
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const PreviewPersonalPluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.personal.previewZip",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/preview`,
  query: PluginBundleZipPreviewQuerySchema,
  upload: "bytes",
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const InstallPersonalPluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.personal.install",
  method: "POST",
  path: `${PluginBundlesPersonalPath}`,
  body: InstallPluginBundleRequestSchema,
  success: InstallPluginBundleResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const InstallPersonalPluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.personal.installZip",
  method: "POST",
  path: `${PluginBundlesPersonalPath}`,
  query: PluginBundleZipInstallQuerySchema,
  upload: "bytes",
  success: InstallPluginBundleResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const PreviewPersonalPluginBundleUpdateEndpoint = defineEndpoint({
  id: "pluginBundles.personal.previewUpdate",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/:pluginId/update/preview`,
  params: PluginBundleParamsSchema,
  body: PluginBundleEmptyRequestSchema,
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals: pluginBundleRefusals,
});

export const PreviewPersonalPluginBundleUpdateZipEndpoint = defineEndpoint({
  id: "pluginBundles.personal.previewUpdateZip",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/:pluginId/update/preview`,
  params: PluginBundleParamsSchema,
  query: PluginBundleZipPreviewQuerySchema,
  upload: "bytes",
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals: pluginBundleRefusals,
});

export const UpdatePersonalPluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.personal.update",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/:pluginId/update`,
  params: PluginBundleParamsSchema,
  body: InstallPluginBundleRequestSchema,
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: pluginBundleRefusals,
});

export const UpdatePersonalPluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.personal.updateZip",
  method: "POST",
  path: `${PluginBundlesPersonalPath}/:pluginId/update`,
  params: PluginBundleParamsSchema,
  query: PluginBundleZipInstallQuerySchema,
  upload: "bytes",
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: pluginBundleRefusals,
});

export const PreviewWorkspacePluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.preview",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/preview`,
  params: WorkspacePluginBundlesParamsSchema,
  body: PreviewPluginBundleRequestSchema,
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const PreviewWorkspacePluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.previewZip",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/preview`,
  params: WorkspacePluginBundlesParamsSchema,
  query: PluginBundleZipPreviewQuerySchema,
  upload: "bytes",
  success: PreviewPluginBundleResponseSchema,
  refusals: pluginBundleRefusals,
});

export const InstallWorkspacePluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.install",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}`,
  params: WorkspacePluginBundlesParamsSchema,
  body: InstallPluginBundleRequestSchema,
  success: InstallPluginBundleResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const InstallWorkspacePluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.installZip",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}`,
  params: WorkspacePluginBundlesParamsSchema,
  query: PluginBundleZipInstallQuerySchema,
  upload: "bytes",
  success: InstallPluginBundleResponseSchema,
  successStatus: 201,
  refusals: pluginBundleRefusals,
});

export const PreviewWorkspacePluginBundleUpdateEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.previewUpdate",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/:pluginId/update/preview`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  body: PluginBundleEmptyRequestSchema,
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals: pluginBundleRefusals,
});

export const PreviewWorkspacePluginBundleUpdateZipEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.previewUpdateZip",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/:pluginId/update/preview`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  query: PluginBundleZipPreviewQuerySchema,
  upload: "bytes",
  success: PreviewPluginBundleUpdateResponseSchema,
  refusals: pluginBundleRefusals,
});

export const UpdateWorkspacePluginBundleEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.update",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/:pluginId/update`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  body: InstallPluginBundleRequestSchema,
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: pluginBundleRefusals,
});

export const UpdateWorkspacePluginBundleZipEndpoint = defineEndpoint({
  id: "pluginBundles.workspace.updateZip",
  method: "POST",
  path: `${PluginBundlesWorkspacePath}/:pluginId/update`,
  params: Schema.Struct({
    ...WorkspacePluginBundlesParamsSchema.fields,
    ...PluginBundleParamsSchema.fields,
  }),
  query: PluginBundleZipInstallQuerySchema,
  upload: "bytes",
  success: UpdatePluginBundleSourceResponseSchema,
  refusals: pluginBundleRefusals,
});
