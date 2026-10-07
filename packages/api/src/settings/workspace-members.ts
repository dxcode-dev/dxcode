import {
  WorkspaceDisplayName,
  WorkspaceRole,
  WorkspaceShortName,
} from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const WorkspaceMemberRoleSchema = Schema.Literals([
  "owner",
  "admin",
  "member",
]);

export type WorkspaceMemberRole = typeof WorkspaceMemberRoleSchema.Type;

export const WorkspaceMemberDataSchema = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: WorkspaceMemberRoleSchema,
  joinedAt: Schema.String,
  lastActiveAt: Schema.optional(Schema.String),
});

export type WorkspaceMemberData = typeof WorkspaceMemberDataSchema.Type;

export const ListWorkspaceMembersResponseSchema = successResponse(
  Schema.Struct({
    members: Schema.Array(WorkspaceMemberDataSchema),
    viewer: Schema.Struct({ userId: Schema.String, role: WorkspaceRole }),
  }),
);

export type WorkspaceMembersData =
  (typeof ListWorkspaceMembersResponseSchema.Type)["data"];

export const UpdateWorkspaceMemberRoleRequestSchema = Schema.Struct({
  role: Schema.Literals(["admin", "member"]),
});

export const WorkspaceMemberResponseSchema = successResponse(
  WorkspaceMemberDataSchema,
);

export const RemoveWorkspaceMemberResponseSchema = successResponse(
  Schema.Struct({ removedUserId: Schema.String }),
);

export const LeaveWorkspaceResponseSchema = successResponse(
  Schema.Struct({ left: Schema.Literal(true) }),
);

export const WorkspaceInviteLinkStatusSchema = Schema.Literals([
  "active",
  "expired",
  "revoked",
]);

export const WorkspaceInviteLinkDataSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  status: WorkspaceInviteLinkStatusSchema,
  expiresAt: Schema.optional(Schema.String),
  useCount: Schema.Int,
  createdAt: Schema.String,
  createdBy: Schema.Struct({ userId: Schema.String, name: Schema.String }),
});

export type WorkspaceInviteLinkData = typeof WorkspaceInviteLinkDataSchema.Type;

export const ListWorkspaceInviteLinksResponseSchema = successResponse(
  Schema.Struct({ links: Schema.Array(WorkspaceInviteLinkDataSchema) }),
);

export const CreateWorkspaceInviteLinkRequestSchema = Schema.Struct({
  title: Schema.String,
  expiresAt: Schema.optional(Schema.String),
});

export type CreateWorkspaceInviteLinkRequest =
  typeof CreateWorkspaceInviteLinkRequestSchema.Type;

export const WorkspaceInviteLinkResponseSchema = successResponse(
  WorkspaceInviteLinkDataSchema,
);

export const RevokeWorkspaceInviteLinkResponseSchema = successResponse(
  Schema.Struct({ revokedLinkId: Schema.String }),
);

export const WorkspaceInviteStatusSchema = Schema.Literals([
  "valid",
  "expired",
  "revoked",
  "not-found",
]);

export type WorkspaceInviteStatus = typeof WorkspaceInviteStatusSchema.Type;

/** Public preview of an invite token. Reveals the workspace name only when valid. */
export const WorkspaceInvitePreviewResponseSchema = successResponse(
  Schema.Struct({
    status: WorkspaceInviteStatusSchema,
    workspace: Schema.optional(
      Schema.Struct({
        displayName: WorkspaceDisplayName,
        shortName: WorkspaceShortName,
      }),
    ),
  }),
);

export type WorkspaceInvitePreview =
  (typeof WorkspaceInvitePreviewResponseSchema.Type)["data"];

export const AcceptWorkspaceInviteResponseSchema = successResponse(
  Schema.Struct({
    workspace: Schema.Struct({
      displayName: WorkspaceDisplayName,
      shortName: WorkspaceShortName,
    }),
    alreadyMember: Schema.Boolean,
  }),
);

export const WorkspaceMembersErrorCode = Schema.Literals([
  "SETTINGS_SCOPE_FORBIDDEN",
  "WORKSPACE_ADMIN_REQUIRED",
  "WORKSPACE_MEMBER_NOT_FOUND",
  "WORKSPACE_OWNER_IMMUTABLE",
  "WORKSPACE_INVITE_LINK_NOT_FOUND",
  "WORKSPACE_INVITE_INVALID",
  "WORKSPACE_MEMBERSHIP_EXISTS",
  "INVALID_WORKSPACE_MEMBERS_REQUEST",
  "PERSISTENCE_UNAVAILABLE",
]);

export type WorkspaceMembersErrorCode = typeof WorkspaceMembersErrorCode.Type;

export const WorkspaceMembersErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: WorkspaceMembersErrorCode,
    message: Schema.String,
    requestId: Schema.String,
    fieldErrors: Schema.optional(Schema.Array(SettingsFieldErrorSchema)),
    workspace: Schema.optional(
      Schema.Struct({
        displayName: WorkspaceDisplayName,
        shortName: WorkspaceShortName,
      }),
    ),
  }),
});
