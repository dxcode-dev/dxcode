import {
  ProjectDefaultOverrides,
  ResolvedProjectDefaults,
  RunnerProfileCatalog,
  RunnerProfileId,
  SettingsScope,
  WorkspaceProjectPolicy,
  WorkspaceRole,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

const ProjectDefaultsRevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

export const ProjectCreationRestrictionsDataSchema = Schema.Struct({
  allowProjectCreation: Schema.Boolean,
  allowPublicCodeAccess: Schema.Boolean,
  allowedRunnerProfileIds: Schema.NullOr(Schema.Array(RunnerProfileId)),
  source: Schema.Literals(["deployment", "workspace"]),
});

export const ProjectDefaultsDataSchema = Schema.Struct({
  scope: SettingsScope,
  revision: ProjectDefaultsRevisionSchema,
  overrides: ProjectDefaultOverrides,
  resolved: ResolvedProjectDefaults,
  catalog: RunnerProfileCatalog,
  restrictions: ProjectCreationRestrictionsDataSchema,
  canUpdate: Schema.Boolean,
  workspaceRole: Schema.optional(WorkspaceRole),
  policy: Schema.optional(WorkspaceProjectPolicy),
});

export type ProjectDefaultsData = typeof ProjectDefaultsDataSchema.Type;

export const ProjectDefaultsWorkspaceParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const UpdatePersonalProjectDefaultsRequestSchema = Schema.Struct({
  expectedRevision: ProjectDefaultsRevisionSchema,
  overrides: ProjectDefaultOverrides,
});

export const UpdateWorkspaceProjectDefaultsRequestSchema = Schema.Struct({
  expectedRevision: ProjectDefaultsRevisionSchema,
  overrides: ProjectDefaultOverrides,
  policy: WorkspaceProjectPolicy,
});

export const GetProjectDefaultsResponseSchema = successResponse(
  ProjectDefaultsDataSchema,
);

export const UpdateProjectDefaultsResponseSchema =
  GetProjectDefaultsResponseSchema;

export const ProjectDefaultsInvalidRequestResponseSchema = errorResponse(
  "INVALID_PROJECT_DEFAULTS",
  "Project defaults validation failed.",
);

export const ProjectDefaultsForbiddenResponseSchema = errorResponse(
  "PROJECT_DEFAULTS_FORBIDDEN",
  "The project defaults scope is unavailable for this user.",
);

export const ProjectDefaultsConflictResponseSchema = errorResponse(
  "PROJECT_DEFAULTS_CONFLICT",
  "Project defaults changed in another session.",
);

export const RunnerProfileUnavailableResponseSchema = errorResponse(
  "RUNNER_PROFILE_UNAVAILABLE",
  "The selected runner profile is unavailable.",
);

export const ProjectDefaultsPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Project defaults are temporarily unavailable.",
  );

export const ProjectDefaultsErrorResponseSchema = Schema.Union([
  ProjectDefaultsInvalidRequestResponseSchema,
  ProjectDefaultsForbiddenResponseSchema,
  ProjectDefaultsConflictResponseSchema,
  RunnerProfileUnavailableResponseSchema,
  ProjectDefaultsPersistenceUnavailableResponseSchema,
]);

export type UpdatePersonalProjectDefaultsRequest =
  typeof UpdatePersonalProjectDefaultsRequestSchema.Type;
export type UpdateWorkspaceProjectDefaultsRequest =
  typeof UpdateWorkspaceProjectDefaultsRequestSchema.Type;
