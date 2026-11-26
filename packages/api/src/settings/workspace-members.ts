import {
  WorkspaceDisplayName,
  WorkspaceRole,
  WorkspaceShortName,
} from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";
import { WorkspaceSettingsParamsSchema } from "./workspace-params.js";

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
  image: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  /** Their username, which `@` tags them by. */
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
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

/**
 * Deleting a workspace. `confirmShortName` must repeat its short name.
 * `threads`: keep moves every Thread in its Projects to its owner, archived
 * and read-only; delete deletes them as deleting a Thread does.
 */
export const DeleteWorkspaceRequestSchema = Schema.Struct({
  confirmShortName: Schema.String,
  threads: Schema.Literals(["keep", "delete"]),
});

export type DeleteWorkspaceRequest = typeof DeleteWorkspaceRequestSchema.Type;

export const DeleteWorkspaceResponseSchema = successResponse(
  Schema.Struct({
    deleted: Schema.Literal(true),
    keptThreadCount: Schema.Int,
    deletedThreadCount: Schema.Int,
  }),
);

export type DeleteWorkspaceData =
  (typeof DeleteWorkspaceResponseSchema.Type)["data"];

export const WorkspaceInviteLinkStatusSchema = Schema.Literals([
  "active",
  "expired",
  "revoked",
  "used-up",
]);

export const WorkspaceInviteLinkDataSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  status: WorkspaceInviteLinkStatusSchema,
  expiresAt: Schema.optional(Schema.String),
  useCount: Schema.Int,
  /** How many people can join through the link. Absent when unlimited. */
  maxUses: Schema.optional(Schema.Int),
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
  /** From 1 to 1000; omit for unlimited. */
  maxUses: Schema.optional(Schema.Int),
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
  "used-up",
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
  "WORKSPACE_OWNER_REQUIRED",
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

/**
 * Every member, invite link, and invite route refuses with this one schema,
 * its `code` naming the reason, at these statuses.
 */
const workspaceMembersRefusals = [400, 403, 404, 409, 503].map((status) => ({
  status,
  schema: WorkspaceMembersErrorResponseSchema,
}));

const WorkspaceMemberParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSettingsParamsSchema.fields.workspaceSlug,
  userId: Schema.String,
});

const WorkspaceInviteLinkParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSettingsParamsSchema.fields.workspaceSlug,
  linkId: Schema.String,
});

export const ListWorkspaceMembersEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.list",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug/members",
  params: WorkspaceSettingsParamsSchema,
  success: ListWorkspaceMembersResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const UpdateWorkspaceMemberRoleEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.updateRole",
  method: "PATCH",
  path: "/v1/settings/workspaces/:workspaceSlug/members/:userId",
  params: WorkspaceMemberParamsSchema,
  body: UpdateWorkspaceMemberRoleRequestSchema,
  success: WorkspaceMemberResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const RemoveWorkspaceMemberEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.remove",
  method: "DELETE",
  path: "/v1/settings/workspaces/:workspaceSlug/members/:userId",
  params: WorkspaceMemberParamsSchema,
  success: RemoveWorkspaceMemberResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const TransferWorkspaceOwnershipEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.transferOwnership",
  method: "POST",
  path: "/v1/settings/workspaces/:workspaceSlug/members/:userId/transfer-ownership",
  params: WorkspaceMemberParamsSchema,
  success: WorkspaceMemberResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const DeleteWorkspaceEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.deleteWorkspace",
  method: "POST",
  path: "/v1/settings/workspaces/:workspaceSlug/delete",
  params: WorkspaceSettingsParamsSchema,
  body: DeleteWorkspaceRequestSchema,
  success: DeleteWorkspaceResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const LeaveWorkspaceEndpoint = defineEndpoint({
  id: "settings.workspaceMembers.leave",
  method: "POST",
  path: "/v1/settings/workspaces/:workspaceSlug/leave",
  params: WorkspaceSettingsParamsSchema,
  success: LeaveWorkspaceResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const ListWorkspaceInviteLinksEndpoint = defineEndpoint({
  id: "settings.workspaceInviteLinks.list",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug/invite-links",
  params: WorkspaceSettingsParamsSchema,
  success: ListWorkspaceInviteLinksResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const CreateWorkspaceInviteLinkEndpoint = defineEndpoint({
  id: "settings.workspaceInviteLinks.create",
  method: "POST",
  path: "/v1/settings/workspaces/:workspaceSlug/invite-links",
  params: WorkspaceSettingsParamsSchema,
  body: CreateWorkspaceInviteLinkRequestSchema,
  success: WorkspaceInviteLinkResponseSchema,
  successStatus: 201,
  refusals: workspaceMembersRefusals,
});

export const RevokeWorkspaceInviteLinkEndpoint = defineEndpoint({
  id: "settings.workspaceInviteLinks.revoke",
  method: "DELETE",
  path: "/v1/settings/workspaces/:workspaceSlug/invite-links/:linkId",
  params: WorkspaceInviteLinkParamsSchema,
  success: RevokeWorkspaceInviteLinkResponseSchema,
  refusals: workspaceMembersRefusals,
});

export const AcceptWorkspaceInviteEndpoint = defineEndpoint({
  id: "settings.workspaceInvites.accept",
  method: "POST",
  path: "/v1/invites/:token/accept",
  params: Schema.Struct({ token: Schema.String }),
  success: AcceptWorkspaceInviteResponseSchema,
  refusals: workspaceMembersRefusals,
});
