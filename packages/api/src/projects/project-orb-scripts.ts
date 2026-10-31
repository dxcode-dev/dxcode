import {
  ProjectId,
  ProjectOrbScriptBody,
  ProjectOrbScriptKind,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const ProjectOrbScriptSchema = Schema.Struct({
  kind: ProjectOrbScriptKind,
  body: ProjectOrbScriptBody,
  updatedAt: Timestamp,
});

/** The Project's saved scripts; a kind without a script is absent. */
export const ProjectOrbScriptsDataSchema = Schema.Struct({
  scripts: Schema.Array(ProjectOrbScriptSchema),
});

export const ProjectOrbScriptsParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

export const UpdateProjectOrbScriptParamsSchema = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectOrbScriptKind,
});

/** An empty or blank body removes the script. */
export const UpdateProjectOrbScriptRequestSchema = Schema.Struct({
  body: ProjectOrbScriptBody,
});

export const GetProjectOrbScriptsResponseSchema = successResponse(
  ProjectOrbScriptsDataSchema,
);

export const UpdateProjectOrbScriptResponseSchema = successResponse(
  ProjectOrbScriptsDataSchema,
);

export const ProjectOrbScriptsInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const ProjectOrbScriptsNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);

export const ProjectOrbScriptsForbiddenResponseSchema = errorResponse(
  "PROJECT_MANAGE_REQUIRED",
  "Only the project's creator or a workspace admin can change its scripts.",
);

export const ProjectOrbScriptsPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );

export type ProjectOrbScriptsData = typeof ProjectOrbScriptsDataSchema.Type;
export type GetProjectOrbScriptsResponse =
  typeof GetProjectOrbScriptsResponseSchema.Encoded;
export type UpdateProjectOrbScriptRequest =
  typeof UpdateProjectOrbScriptRequestSchema.Encoded;
export type UpdateProjectOrbScriptResponse =
  typeof UpdateProjectOrbScriptResponseSchema.Encoded;
