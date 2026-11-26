import {
  WorkspaceDisplayName,
  WorkspaceId,
  WorkspaceLifecycleState,
  WorkspaceProfileRevision,
  WorkspaceRole,
  WorkspaceShortName,
} from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";
import { WorkspaceSettingsParamsSchema } from "./workspace-params.js";

export const WorkspaceProfileDataSchema = Schema.Struct({
  id: WorkspaceId,
  displayName: WorkspaceDisplayName,
  shortName: WorkspaceShortName,
  lifecycleState: WorkspaceLifecycleState,
  revision: WorkspaceProfileRevision,
  role: WorkspaceRole,
  /** The uploaded picture; absent shows initials. */
  avatarUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
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

const workspaceProfileRefusals = [
  { status: 400, schema: WorkspaceProfileInvalidRequestResponseSchema },
  { status: 403, schema: WorkspaceProfileForbiddenResponseSchema },
  { status: 409, schema: WorkspaceShortNameUnavailableResponseSchema },
  { status: 409, schema: WorkspaceMembershipExistsResponseSchema },
  { status: 409, schema: WorkspaceProfileConflictResponseSchema },
  { status: 503, schema: WorkspaceProfilePersistenceUnavailableResponseSchema },
];

export const CreateWorkspaceEndpoint = defineEndpoint({
  id: "settings.workspaceProfile.create",
  method: "POST",
  path: "/v1/settings/workspaces",
  body: CreateWorkspaceRequestSchema,
  success: CreateWorkspaceResponseSchema,
  successStatus: 201,
  refusals: workspaceProfileRefusals,
});

export const GetWorkspaceProfileEndpoint = defineEndpoint({
  id: "settings.workspaceProfile.get",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug",
  params: WorkspaceSettingsParamsSchema,
  success: GetWorkspaceProfileResponseSchema,
  refusals: workspaceProfileRefusals,
});

export const UpdateWorkspaceProfileEndpoint = defineEndpoint({
  id: "settings.workspaceProfile.update",
  method: "PATCH",
  path: "/v1/settings/workspaces/:workspaceSlug",
  params: WorkspaceSettingsParamsSchema,
  body: UpdateWorkspaceProfileRequestSchema,
  success: UpdateWorkspaceProfileResponseSchema,
  refusals: workspaceProfileRefusals,
});

/** Replaces the workspace's picture with an image file. */
export const SetWorkspaceAvatarEndpoint = defineEndpoint({
  id: "settings.workspaceProfile.avatar.set",
  method: "PUT",
  path: "/v1/settings/workspaces/:workspaceSlug/avatar",
  params: WorkspaceSettingsParamsSchema,
  upload: "bytes",
  success: UpdateWorkspaceProfileResponseSchema,
  refusals: workspaceProfileRefusals,
});

export const RemoveWorkspaceAvatarEndpoint = defineEndpoint({
  id: "settings.workspaceProfile.avatar.remove",
  method: "DELETE",
  path: "/v1/settings/workspaces/:workspaceSlug/avatar",
  params: WorkspaceSettingsParamsSchema,
  success: UpdateWorkspaceProfileResponseSchema,
  refusals: workspaceProfileRefusals,
});
