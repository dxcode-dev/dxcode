import { ProjectId, WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const MoveProjectParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

/**
 * `POST /v1/projects/:projectId/move` (Change Owner): moves the creator's
 * personal project into `workspaceSlug`, their workspace, for good.
 * `revision` is the project revision the request was made against.
 */
export const MoveProjectRequestSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
  revision: Schema.Int,
});

export type MoveProjectRequest = typeof MoveProjectRequestSchema.Type;

/**
 * The moved project, under workspace policy, and how many of its running
 * Orbs stopped because they ran on the owner's personal Orb keys, which the
 * workspace does not allow.
 */
export const MoveProjectResponseSchema = successResponse(
  Schema.Struct({
    project: ProjectDataSchema,
    stoppedOrbCount: Schema.Int,
  }),
);

export type MoveProjectData = (typeof MoveProjectResponseSchema.Type)["data"];

export const MoveProjectInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const MoveProjectNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);
export const MoveProjectNameConflictResponseSchema = errorResponse(
  "PROJECT_NAME_CONFLICT",
  "A project with this name already exists.",
);
export const MoveProjectForbiddenResponseSchema = errorResponse(
  "PROJECT_MOVE_FORBIDDEN",
  "You cannot move projects into this workspace.",
);
export const MoveProjectPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
