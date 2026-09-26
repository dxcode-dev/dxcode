import { ProjectId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const GetProjectParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

export const GetProjectResponseSchema = successResponse(ProjectDataSchema);

export const GetProjectInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const GetProjectNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);

export const GetProjectPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export type GetProjectResponse = typeof GetProjectResponseSchema.Encoded;
export type GetProjectInvalidRequestResponse =
  typeof GetProjectInvalidRequestResponseSchema.Type;
export type GetProjectNotFoundResponse =
  typeof GetProjectNotFoundResponseSchema.Type;
export type GetProjectPersistenceUnavailableResponse =
  typeof GetProjectPersistenceUnavailableResponseSchema.Type;
