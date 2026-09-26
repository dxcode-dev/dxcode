import {
  WorkspaceDisplayName,
  WorkspaceId,
  WorkspaceLifecycleState,
  WorkspaceProfileRevision,
  WorkspaceRole,
  WorkspaceShortName,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const WorkspaceProfileDataSchema = Schema.Struct({
  id: WorkspaceId,
  displayName: WorkspaceDisplayName,
  shortName: WorkspaceShortName,
  lifecycleState: WorkspaceLifecycleState,
  revision: WorkspaceProfileRevision,
  role: WorkspaceRole,
});

export const WorkspaceProfileParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceShortName,
});

export const CreateWorkspaceRequestSchema = Schema.Struct({
  displayName: Schema.String,
  shortName: Schema.String,
});

export const UpdateWorkspaceProfileRequestSchema = Schema.Struct({
  displayName: Schema.String,
  shortName: Schema.String,
  expectedRevision: WorkspaceProfileRevision,
});

export const GetWorkspaceProfileResponseSchema = successResponse(
  WorkspaceProfileDataSchema,
);

export const CreateWorkspaceResponseSchema = GetWorkspaceProfileResponseSchema;

export const UpdateWorkspaceProfileResponseSchema =
  GetWorkspaceProfileResponseSchema;

export const WorkspaceProfileInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_WORKSPACE_PROFILE"),
    message: Schema.Literal("Workspace profile validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const WorkspaceShortNameUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_SHORT_NAME_UNAVAILABLE"),
    message: Schema.Literal("That workspace short name is already in use."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const WorkspaceMembershipExistsResponseSchema = errorResponse(
  "WORKSPACE_MEMBERSHIP_EXISTS",
  "This user already belongs to a workspace.",
);

export const WorkspaceProfileConflictResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_PROFILE_CONFLICT"),
    message: Schema.Literal(
      "Workspace profile changed since you started editing.",
    ),
    requestId: Schema.String,
    currentRevision: WorkspaceProfileRevision,
  }),
});

export const WorkspaceProfileForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const WorkspaceProfilePersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Workspace settings are temporarily unavailable.",
  );

export const WorkspaceProfileErrorResponseSchema = Schema.Union([
  WorkspaceProfileInvalidRequestResponseSchema,
  WorkspaceShortNameUnavailableResponseSchema,
  WorkspaceMembershipExistsResponseSchema,
  WorkspaceProfileConflictResponseSchema,
  WorkspaceProfileForbiddenResponseSchema,
  WorkspaceProfilePersistenceUnavailableResponseSchema,
]);

export type WorkspaceProfileData = typeof WorkspaceProfileDataSchema.Type;
export type CreateWorkspaceRequest = typeof CreateWorkspaceRequestSchema.Type;
export type UpdateWorkspaceProfileRequest =
  typeof UpdateWorkspaceProfileRequestSchema.Type;
export type GetWorkspaceProfileResponse =
  typeof GetWorkspaceProfileResponseSchema.Encoded;
export type CreateWorkspaceResponse =
  typeof CreateWorkspaceResponseSchema.Encoded;
export type UpdateWorkspaceProfileResponse =
  typeof UpdateWorkspaceProfileResponseSchema.Encoded;
