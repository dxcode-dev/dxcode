import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  ApplyBulkEnvironmentVariablesRequestSchema,
  ApplyBulkEnvironmentVariablesResponseSchema,
  BulkEnvironmentVariablesRequestSchema,
  CreateEnvironmentVariableRequestSchema,
  CreateEnvironmentVariableResponseSchema,
  DeleteEnvironmentVariableResponseSchema,
  EnvironmentVariableConflictResponseSchema,
  EnvironmentVariableHistoryQuerySchema,
  EnvironmentVariableLimitResponseSchema,
  EnvironmentVariableNotFoundResponseSchema,
  EnvironmentVariableParamsSchema,
  EnvironmentVariableScopeRequestSchema,
  EnvironmentVariablesBrowserSessionRequiredResponseSchema,
  EnvironmentVariablesForbiddenResponseSchema,
  EnvironmentVariablesInvalidRequestResponseSchema,
  EnvironmentVariablesUnavailableResponseSchema,
  ListEnvironmentVariableHistoryResponseSchema,
  ListEnvironmentVariablesResponseSchema,
  PreviewBulkEnvironmentVariablesResponseSchema,
  RotateEnvironmentVariableRequestSchema,
  RotateEnvironmentVariableResponseSchema,
  UpdateEnvironmentVariableRequestSchema,
  UpdateEnvironmentVariableResponseSchema,
} from "./environment-variables.js";

/**
 * The endpoints over `environment-variables.ts`. In their own module, so code
 * that imports only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const environmentVariablesRefusals = [
  { status: 400, schema: EnvironmentVariablesInvalidRequestResponseSchema },
  { status: 403, schema: EnvironmentVariablesForbiddenResponseSchema },
  {
    status: 403,
    schema: EnvironmentVariablesBrowserSessionRequiredResponseSchema,
  },
  { status: 404, schema: EnvironmentVariableNotFoundResponseSchema },
  { status: 409, schema: EnvironmentVariableConflictResponseSchema },
  { status: 409, schema: EnvironmentVariableLimitResponseSchema },
  { status: 503, schema: EnvironmentVariablesUnavailableResponseSchema },
];

const PersonalEnvironmentVariablesPath =
  "/v1/settings/personal/environment-variables";
const WorkspaceEnvironmentVariablesPath =
  "/v1/settings/workspaces/:workspaceSlug/environment-variables";

export const WorkspaceEnvironmentVariablesParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const WorkspaceEnvironmentVariableParamsSchema = Schema.Struct({
  ...WorkspaceEnvironmentVariablesParamsSchema.fields,
  ...EnvironmentVariableParamsSchema.fields,
});

/**
 * Personal routes also serve a Project's variables: `scope` (`personal` or
 * `project`) and `projectId` pick which, in the query or the body.
 */
export const ListPersonalEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.personal.list",
  summary: "List personal environment variables and secrets",
  method: "GET",
  path: PersonalEnvironmentVariablesPath,
  query: EnvironmentVariableScopeRequestSchema,
  success: ListEnvironmentVariablesResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const ListWorkspaceEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.list",
  summary: "List workspace environment variables and secrets",
  method: "GET",
  path: WorkspaceEnvironmentVariablesPath,
  params: WorkspaceEnvironmentVariablesParamsSchema,
  success: ListEnvironmentVariablesResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const CreatePersonalEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.personal.create",
  summary: "Add a personal environment variable or secret",
  method: "POST",
  path: PersonalEnvironmentVariablesPath,
  body: CreateEnvironmentVariableRequestSchema,
  success: CreateEnvironmentVariableResponseSchema,
  successStatus: 201,
  refusals: environmentVariablesRefusals,
});

export const CreateWorkspaceEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.create",
  summary: "Add a workspace environment variable or secret",
  method: "POST",
  path: WorkspaceEnvironmentVariablesPath,
  params: WorkspaceEnvironmentVariablesParamsSchema,
  body: CreateEnvironmentVariableRequestSchema,
  success: CreateEnvironmentVariableResponseSchema,
  successStatus: 201,
  refusals: environmentVariablesRefusals,
});

export const UpdatePersonalEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.personal.update",
  summary: "Change a personal environment variable or secret",
  method: "PATCH",
  path: `${PersonalEnvironmentVariablesPath}/:environmentVariableId`,
  params: EnvironmentVariableParamsSchema,
  query: EnvironmentVariableScopeRequestSchema,
  body: UpdateEnvironmentVariableRequestSchema,
  success: UpdateEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const UpdateWorkspaceEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.update",
  summary: "Change a workspace environment variable or secret",
  method: "PATCH",
  path: `${WorkspaceEnvironmentVariablesPath}/:environmentVariableId`,
  params: WorkspaceEnvironmentVariableParamsSchema,
  body: UpdateEnvironmentVariableRequestSchema,
  success: UpdateEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const RotatePersonalEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.personal.rotate",
  summary: "Rotate a personal secret's value",
  method: "POST",
  path: `${PersonalEnvironmentVariablesPath}/:environmentVariableId/rotate`,
  params: EnvironmentVariableParamsSchema,
  query: EnvironmentVariableScopeRequestSchema,
  body: RotateEnvironmentVariableRequestSchema,
  success: RotateEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const RotateWorkspaceEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.rotate",
  summary: "Rotate a workspace secret's value",
  method: "POST",
  path: `${WorkspaceEnvironmentVariablesPath}/:environmentVariableId/rotate`,
  params: WorkspaceEnvironmentVariableParamsSchema,
  body: RotateEnvironmentVariableRequestSchema,
  success: RotateEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const DeletePersonalEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.personal.delete",
  summary: "Delete a personal environment variable or secret",
  method: "DELETE",
  path: `${PersonalEnvironmentVariablesPath}/:environmentVariableId`,
  params: EnvironmentVariableParamsSchema,
  query: EnvironmentVariableScopeRequestSchema,
  success: DeleteEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const DeleteWorkspaceEnvironmentVariableEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.delete",
  summary: "Delete a workspace environment variable or secret",
  method: "DELETE",
  path: `${WorkspaceEnvironmentVariablesPath}/:environmentVariableId`,
  params: WorkspaceEnvironmentVariableParamsSchema,
  success: DeleteEnvironmentVariableResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const ListPersonalEnvironmentVariableHistoryEndpoint = defineEndpoint({
  id: "environmentVariables.personal.history",
  summary: "List changes to personal environment variables",
  method: "GET",
  path: `${PersonalEnvironmentVariablesPath}/history`,
  query: EnvironmentVariableHistoryQuerySchema,
  success: ListEnvironmentVariableHistoryResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const ListWorkspaceEnvironmentVariableHistoryEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.history",
  summary: "List changes to workspace environment variables",
  method: "GET",
  path: `${WorkspaceEnvironmentVariablesPath}/history`,
  params: WorkspaceEnvironmentVariablesParamsSchema,
  query: EnvironmentVariableHistoryQuerySchema,
  success: ListEnvironmentVariableHistoryResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const PreviewPersonalBulkEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.personal.bulkPreview",
  summary: "Preview a bulk edit of personal environment variables",
  method: "POST",
  path: `${PersonalEnvironmentVariablesPath}/bulk/preview`,
  body: BulkEnvironmentVariablesRequestSchema,
  success: PreviewBulkEnvironmentVariablesResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const PreviewWorkspaceBulkEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.bulkPreview",
  summary: "Preview a bulk edit of workspace environment variables",
  method: "POST",
  path: `${WorkspaceEnvironmentVariablesPath}/bulk/preview`,
  params: WorkspaceEnvironmentVariablesParamsSchema,
  body: BulkEnvironmentVariablesRequestSchema,
  success: PreviewBulkEnvironmentVariablesResponseSchema,
  refusals: environmentVariablesRefusals,
});

export const ApplyPersonalBulkEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.personal.bulkApply",
  summary: "Apply a bulk edit of personal environment variables",
  method: "POST",
  path: `${PersonalEnvironmentVariablesPath}/bulk`,
  body: ApplyBulkEnvironmentVariablesRequestSchema,
  success: ApplyBulkEnvironmentVariablesResponseSchema,
  successStatus: 201,
  refusals: environmentVariablesRefusals,
});

export const ApplyWorkspaceBulkEnvironmentVariablesEndpoint = defineEndpoint({
  id: "environmentVariables.workspace.bulkApply",
  summary: "Apply a bulk edit of workspace environment variables",
  method: "POST",
  path: `${WorkspaceEnvironmentVariablesPath}/bulk`,
  params: WorkspaceEnvironmentVariablesParamsSchema,
  body: ApplyBulkEnvironmentVariablesRequestSchema,
  success: ApplyBulkEnvironmentVariablesResponseSchema,
  successStatus: 201,
  refusals: environmentVariablesRefusals,
});
