import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  ApproveSkillProposalRequestSchema,
  DecideSkillProposalResponseSchema,
  DiscoverSkillsResponseSchema,
  ExportSkillResponseSchema,
  ImportSkillRequestSchema,
  ImportSkillResponseSchema,
  InstallSkillRequestSchema,
  InstallSkillResponseSchema,
  ListSkillsResponseSchema,
  PreviewSkillRequestSchema,
  PreviewSkillResponseSchema,
  PreviewSkillSourceRequestSchema,
  PreviewSkillSourceResponseSchema,
  PublishSkillVersionRequestSchema,
  PublishSkillVersionResponseSchema,
  RemoveSkillResponseSchema,
  SkillFileResponseSchema,
  SkillIntegrityConflictResponseSchema,
  SkillLimitResponseSchema,
  SkillMcpReferenceInvalidResponseSchema,
  SkillNotFoundResponseSchema,
  SkillParamsSchema,
  SkillProposalDecidedResponseSchema,
  SkillProposalNotFoundResponseSchema,
  SkillProposalParamsSchema,
  SkillSourceUnavailableResponseSchema,
  SkillsForbiddenResponseSchema,
  SkillsInvalidRequestResponseSchema,
  SkillsUnavailableResponseSchema,
  UpdateSkillStateRequestSchema,
  UpdateSkillStateResponseSchema,
  UpdateSkillWorkspacePolicyRequestSchema,
  UpdateSkillWorkspacePolicyResponseSchema,
} from "./skills.js";

/**
 * The endpoints over `skills.ts`'s schemas. Apart from them, so code that
 * imports only the schemas (some on the Thread page's first load) does not
 * carry the endpoint definitions.
 */

const skillsRefusals = [
  { status: 503, schema: SkillSourceUnavailableResponseSchema },
  { status: 400, schema: SkillsInvalidRequestResponseSchema },
  { status: 403, schema: SkillsForbiddenResponseSchema },
  { status: 404, schema: SkillNotFoundResponseSchema },
  { status: 409, schema: SkillLimitResponseSchema },
  { status: 409, schema: SkillIntegrityConflictResponseSchema },
  { status: 409, schema: SkillMcpReferenceInvalidResponseSchema },
  { status: 404, schema: SkillProposalNotFoundResponseSchema },
  { status: 409, schema: SkillProposalDecidedResponseSchema },
  { status: 503, schema: SkillsUnavailableResponseSchema },
];

const SkillsPersonalPath = "/v1/settings/personal/skills";
const SkillsWorkspacePath = "/v1/settings/workspaces/:workspaceSlug/skills";

export const WorkspaceSkillsParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

/** `GET …/:skillId/files?path=`: one file of the active version. */
export const SkillFileQuerySchema = Schema.Struct({ path: Schema.String });

export const ListPersonalSkillsEndpoint = defineEndpoint({
  id: "skills.personal.list",
  method: "GET",
  path: `${SkillsPersonalPath}`,
  success: ListSkillsResponseSchema,
  refusals: skillsRefusals,
});

export const ListWorkspaceSkillsEndpoint = defineEndpoint({
  id: "skills.workspace.list",
  method: "GET",
  path: `${SkillsWorkspacePath}`,
  params: WorkspaceSkillsParamsSchema,
  success: ListSkillsResponseSchema,
  refusals: skillsRefusals,
});

export const PreviewPersonalSkillEndpoint = defineEndpoint({
  id: "skills.personal.preview",
  method: "POST",
  path: `${SkillsPersonalPath}/preview`,
  body: PreviewSkillRequestSchema,
  success: PreviewSkillResponseSchema,
  refusals: skillsRefusals,
});

export const PreviewWorkspaceSkillEndpoint = defineEndpoint({
  id: "skills.workspace.preview",
  method: "POST",
  path: `${SkillsWorkspacePath}/preview`,
  params: WorkspaceSkillsParamsSchema,
  body: PreviewSkillRequestSchema,
  success: PreviewSkillResponseSchema,
  refusals: skillsRefusals,
});

export const ImportPersonalSkillEndpoint = defineEndpoint({
  id: "skills.personal.import",
  method: "POST",
  path: `${SkillsPersonalPath}`,
  body: ImportSkillRequestSchema,
  success: ImportSkillResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const ImportWorkspaceSkillEndpoint = defineEndpoint({
  id: "skills.workspace.import",
  method: "POST",
  path: `${SkillsWorkspacePath}`,
  params: WorkspaceSkillsParamsSchema,
  body: ImportSkillRequestSchema,
  success: ImportSkillResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const PublishPersonalSkillVersionEndpoint = defineEndpoint({
  id: "skills.personal.publishVersion",
  method: "POST",
  path: `${SkillsPersonalPath}/:skillId/versions`,
  params: SkillParamsSchema,
  body: PublishSkillVersionRequestSchema,
  success: PublishSkillVersionResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const PublishWorkspaceSkillVersionEndpoint = defineEndpoint({
  id: "skills.workspace.publishVersion",
  method: "POST",
  path: `${SkillsWorkspacePath}/:skillId/versions`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillParamsSchema.fields,
  }),
  body: PublishSkillVersionRequestSchema,
  success: PublishSkillVersionResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const UpdatePersonalSkillStateEndpoint = defineEndpoint({
  id: "skills.personal.updateState",
  method: "PATCH",
  path: `${SkillsPersonalPath}/:skillId`,
  params: SkillParamsSchema,
  body: UpdateSkillStateRequestSchema,
  success: UpdateSkillStateResponseSchema,
  refusals: skillsRefusals,
});

export const UpdateWorkspaceSkillStateEndpoint = defineEndpoint({
  id: "skills.workspace.updateState",
  method: "PATCH",
  path: `${SkillsWorkspacePath}/:skillId`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillParamsSchema.fields,
  }),
  body: UpdateSkillStateRequestSchema,
  success: UpdateSkillStateResponseSchema,
  refusals: skillsRefusals,
});

export const RemovePersonalSkillEndpoint = defineEndpoint({
  id: "skills.personal.remove",
  method: "DELETE",
  path: `${SkillsPersonalPath}/:skillId`,
  params: SkillParamsSchema,
  success: RemoveSkillResponseSchema,
  refusals: skillsRefusals,
});

export const RemoveWorkspaceSkillEndpoint = defineEndpoint({
  id: "skills.workspace.remove",
  method: "DELETE",
  path: `${SkillsWorkspacePath}/:skillId`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillParamsSchema.fields,
  }),
  success: RemoveSkillResponseSchema,
  refusals: skillsRefusals,
});

export const ExportPersonalSkillEndpoint = defineEndpoint({
  id: "skills.personal.export",
  method: "GET",
  path: `${SkillsPersonalPath}/:skillId/export`,
  params: SkillParamsSchema,
  success: ExportSkillResponseSchema,
  refusals: skillsRefusals,
});

export const ExportWorkspaceSkillEndpoint = defineEndpoint({
  id: "skills.workspace.export",
  method: "GET",
  path: `${SkillsWorkspacePath}/:skillId/export`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillParamsSchema.fields,
  }),
  success: ExportSkillResponseSchema,
  refusals: skillsRefusals,
});

export const ReadPersonalSkillFileEndpoint = defineEndpoint({
  id: "skills.personal.readFile",
  method: "GET",
  path: `${SkillsPersonalPath}/:skillId/files`,
  params: SkillParamsSchema,
  query: SkillFileQuerySchema,
  success: SkillFileResponseSchema,
  refusals: skillsRefusals,
});

export const ReadWorkspaceSkillFileEndpoint = defineEndpoint({
  id: "skills.workspace.readFile",
  method: "GET",
  path: `${SkillsWorkspacePath}/:skillId/files`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillParamsSchema.fields,
  }),
  query: SkillFileQuerySchema,
  success: SkillFileResponseSchema,
  refusals: skillsRefusals,
});

/** `GET …/discover?q=`: skills.sh's most installed, or its matches for `q`. */
export const DiscoverSkillsQuerySchema = Schema.Struct({ q: Schema.String });

/** `reject` takes an empty JSON object. */
export const RejectSkillProposalRequestSchema = Schema.Struct({});

export const DiscoverPersonalSkillsEndpoint = defineEndpoint({
  id: "skills.personal.discover",
  method: "GET",
  path: `${SkillsPersonalPath}/discover`,
  query: DiscoverSkillsQuerySchema,
  success: DiscoverSkillsResponseSchema,
  refusals: skillsRefusals,
});

export const DiscoverWorkspaceSkillsEndpoint = defineEndpoint({
  id: "skills.workspace.discover",
  method: "GET",
  path: `${SkillsWorkspacePath}/discover`,
  params: WorkspaceSkillsParamsSchema,
  query: DiscoverSkillsQuerySchema,
  success: DiscoverSkillsResponseSchema,
  refusals: skillsRefusals,
});

export const PreviewPersonalSkillSourceEndpoint = defineEndpoint({
  id: "skills.personal.previewSource",
  method: "POST",
  path: `${SkillsPersonalPath}/sources/preview`,
  body: PreviewSkillSourceRequestSchema,
  success: PreviewSkillSourceResponseSchema,
  refusals: skillsRefusals,
});

export const PreviewWorkspaceSkillSourceEndpoint = defineEndpoint({
  id: "skills.workspace.previewSource",
  method: "POST",
  path: `${SkillsWorkspacePath}/sources/preview`,
  params: WorkspaceSkillsParamsSchema,
  body: PreviewSkillSourceRequestSchema,
  success: PreviewSkillSourceResponseSchema,
  refusals: skillsRefusals,
});

export const InstallPersonalSkillEndpoint = defineEndpoint({
  id: "skills.personal.install",
  method: "POST",
  path: `${SkillsPersonalPath}/install`,
  body: InstallSkillRequestSchema,
  success: InstallSkillResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const InstallWorkspaceSkillEndpoint = defineEndpoint({
  id: "skills.workspace.install",
  method: "POST",
  path: `${SkillsWorkspacePath}/install`,
  params: WorkspaceSkillsParamsSchema,
  body: InstallSkillRequestSchema,
  success: InstallSkillResponseSchema,
  successStatus: 201,
  refusals: skillsRefusals,
});

export const ApprovePersonalSkillProposalEndpoint = defineEndpoint({
  id: "skills.personal.approveProposal",
  method: "POST",
  path: `${SkillsPersonalPath}/proposals/:proposalId/approve`,
  params: SkillProposalParamsSchema,
  body: ApproveSkillProposalRequestSchema,
  success: DecideSkillProposalResponseSchema,
  refusals: skillsRefusals,
});

export const ApproveWorkspaceSkillProposalEndpoint = defineEndpoint({
  id: "skills.workspace.approveProposal",
  method: "POST",
  path: `${SkillsWorkspacePath}/proposals/:proposalId/approve`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillProposalParamsSchema.fields,
  }),
  body: ApproveSkillProposalRequestSchema,
  success: DecideSkillProposalResponseSchema,
  refusals: skillsRefusals,
});

export const RejectPersonalSkillProposalEndpoint = defineEndpoint({
  id: "skills.personal.rejectProposal",
  method: "POST",
  path: `${SkillsPersonalPath}/proposals/:proposalId/reject`,
  params: SkillProposalParamsSchema,
  body: RejectSkillProposalRequestSchema,
  success: DecideSkillProposalResponseSchema,
  refusals: skillsRefusals,
});

export const RejectWorkspaceSkillProposalEndpoint = defineEndpoint({
  id: "skills.workspace.rejectProposal",
  method: "POST",
  path: `${SkillsWorkspacePath}/proposals/:proposalId/reject`,
  params: Schema.Struct({
    ...WorkspaceSkillsParamsSchema.fields,
    ...SkillProposalParamsSchema.fields,
  }),
  body: RejectSkillProposalRequestSchema,
  success: DecideSkillProposalResponseSchema,
  refusals: skillsRefusals,
});

export const UpdateWorkspaceSkillPolicyEndpoint = defineEndpoint({
  id: "skills.workspace.policy",
  method: "PATCH",
  path: `${SkillsWorkspacePath}/policy`,
  params: WorkspaceSkillsParamsSchema,
  body: UpdateSkillWorkspacePolicyRequestSchema,
  success: UpdateSkillWorkspacePolicyResponseSchema,
  refusals: skillsRefusals,
});
