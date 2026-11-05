import {
  ProjectId,
  ProviderRepositoryId,
  PublicGitRepositoryUrl,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const RebindProjectSourceParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

/**
 * A repository one of the person's connections reaches, or any HTTPS Git URL
 * without credentials, cloned as is like a Project created from a URL.
 */
export const RebindProjectSourceRequestSchema = Schema.Union([
  Schema.Struct({
    revision: Schema.Int,
    grantId: Schema.String,
    providerRepositoryId: ProviderRepositoryId,
    provider: Schema.optional(Schema.Literals(["github", "bitbucket"])),
    workspaceId: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ),
  }),
  Schema.Struct({ revision: Schema.Int, url: PublicGitRepositoryUrl }),
]);
export type RebindProjectSourceRequest =
  typeof RebindProjectSourceRequestSchema.Type;

export const RebindProjectSourceResponseSchema =
  successResponse(ProjectDataSchema);
export const RebindProjectSourceInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const RebindProjectSourceNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);
export const RebindProjectSourceForbiddenResponseSchema = errorResponse(
  "FORBIDDEN",
  "You cannot rebind this Project source.",
);
export const RebindProjectSourcePersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );
