import { ProjectId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const DeleteProjectParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

/**
 * `POST /v1/projects/:projectId/delete`. `confirmName` is the project's
 * name, typed to confirm (case and surrounding spaces are ignored).
 * `threads` says what happens to every Thread in the project: `keep`
 * leaves each with its owner, archived and read-only for good; `delete`
 * deletes them as deleting a Thread does.
 */
export const DeleteProjectRequestSchema = Schema.Struct({
  confirmName: Schema.String,
  threads: Schema.Literals(["keep", "delete"]),
});

export type DeleteProjectRequest = typeof DeleteProjectRequestSchema.Type;

export const DeleteProjectResponseSchema = successResponse(
  Schema.Struct({
    deleted: Schema.Literal(true),
    keptThreadCount: Schema.Int,
    deletedThreadCount: Schema.Int,
  }),
);

export type DeleteProjectData =
  (typeof DeleteProjectResponseSchema.Type)["data"];

export const DeleteProjectInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const DeleteProjectNameMismatchResponseSchema = errorResponse(
  "PROJECT_NAME_MISMATCH",
  "Type the project name to confirm.",
);
export const DeleteProjectNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);
export const DeleteProjectPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
