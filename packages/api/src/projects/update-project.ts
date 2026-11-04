import {
  CommitAuthorPreference,
  MAX_PROJECT_ADDITIONAL_REPOSITORIES,
  ProjectDescription,
  ProjectId,
  ProjectNameInput,
  ProjectShipAction,
  PublicGitRepositoryUrl,
  RunnerProfileId,
  ShipPrompt,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const UpdateProjectParamsSchema = Schema.Struct({
  projectId: ProjectId,
});
export const UpdateProjectRequestSchema = Schema.Struct({
  revision: Schema.Int,
  name: Schema.optional(ProjectNameInput),
  description: Schema.optional(ProjectDescription),
  runnerProfileId: Schema.optional(RunnerProfileId),
  /** Custom Ship needs a prompt, sent with it or already saved. */
  shipAction: Schema.optional(ProjectShipAction),
  shipPrompt: Schema.optional(ShipPrompt),
  commitAuthor: Schema.optional(CommitAuthorPreference),
  dxCoAuthor: Schema.optional(Schema.Boolean),
  additionalRepositories: Schema.optional(
    Schema.Array(PublicGitRepositoryUrl).check(
      Schema.isMaxLength(MAX_PROJECT_ADDITIONAL_REPOSITORIES),
    ),
  ),
});
export const UpdateProjectResponseSchema = successResponse(ProjectDataSchema);
export const UpdateProjectInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const UpdateProjectNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);
/** The icon's bytes are not a PNG, JPEG, or WebP image, whatever its name. */
export const ProjectIconNotImageResponseSchema = errorResponse(
  "PROJECT_ICON_NOT_IMAGE",
  "Choose a PNG, JPEG, or WebP image.",
);
export const ProjectIconTooLargeResponseSchema = errorResponse(
  "PROJECT_ICON_TOO_LARGE",
  "Choose an image of 512 KB or less.",
);
export const UpdateProjectPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export const UpdateProjectNameConflictResponseSchema = errorResponse(
  "PROJECT_NAME_CONFLICT",
  "A project with this name already exists.",
);
export const UpdateProjectRunnerUnavailableResponseSchema = errorResponse(
  "RUNNER_PROFILE_UNAVAILABLE",
  "The selected runner profile is unavailable.",
);
export const UpdateProjectPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal(
      "Workspace policy does not allow this runner profile.",
    ),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});
