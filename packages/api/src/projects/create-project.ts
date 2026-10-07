import {
  BitbucketRepositoryUrl,
  GitHubRepositoryUrl,
  MAX_PROJECT_ADDITIONAL_REPOSITORIES,
  ProjectDescription,
  ProjectNameInput,
  ProviderRepositoryId,
  PublicGitRepositoryUrl,
  WorkspacePolicyDenialReason,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const CreateProjectRequestSchema = Schema.Struct({
  name: ProjectNameInput,
  description: Schema.optional(ProjectDescription),
  source: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("scratch") }),
      Schema.Struct({
        kind: Schema.Literal("repository"),
        grantId: Schema.String,
        providerRepositoryId: ProviderRepositoryId,
        provider: Schema.optional(Schema.Literals(["github", "bitbucket"])),
        workspaceId: Schema.optional(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
      }),
      Schema.Struct({
        kind: Schema.Literal("github-url"),
        url: GitHubRepositoryUrl,
      }),
      Schema.Struct({
        kind: Schema.Literal("bitbucket-url"),
        url: BitbucketRepositoryUrl,
      }),
      Schema.Struct({
        kind: Schema.Literal("public-git-url"),
        url: PublicGitRepositoryUrl,
      }),
    ]),
  ),
  additionalRepositories: Schema.optional(
    Schema.Array(PublicGitRepositoryUrl).check(
      Schema.isMaxLength(MAX_PROJECT_ADDITIONAL_REPOSITORIES),
    ),
  ),
  workspaceSlug: Schema.optional(WorkspaceSlug),
  publicCodeEnabled: Schema.optional(Schema.Boolean),
});

export const CreateProjectResponseSchema = successResponse(ProjectDataSchema);

export const CreateProjectInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const CreateProjectPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export const CreateProjectNameConflictResponseSchema = errorResponse(
  "PROJECT_NAME_CONFLICT",
  "A project with this name already exists.",
);

export const CreateProjectForbiddenResponseSchema = errorResponse(
  "PROJECT_CREATION_FORBIDDEN",
  "Workspace policy does not allow this project.",
);

export const CreateProjectPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal("Workspace policy does not allow this project."),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export const CreateProjectRunnerUnavailableResponseSchema = errorResponse(
  "RUNNER_PROFILE_UNAVAILABLE",
  "The selected runner profile is unavailable.",
);

export type CreateProjectResponse = typeof CreateProjectResponseSchema.Encoded;
export type CreateProjectInvalidRequestResponse =
  typeof CreateProjectInvalidRequestResponseSchema.Type;
export type CreateProjectPersistenceUnavailableResponse =
  typeof CreateProjectPersistenceUnavailableResponseSchema.Type;
