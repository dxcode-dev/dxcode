import { Schema } from "effect";
import { UserId } from "../users/user-id.js";

export const WorkspaceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/WorkspaceId"));

export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspaceDisplayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/WorkspaceDisplayName"));

export type WorkspaceDisplayName = typeof WorkspaceDisplayName.Type;

export const WorkspaceShortName = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/),
).pipe(Schema.brand("@dx/WorkspaceShortName"));

export type WorkspaceShortName = typeof WorkspaceShortName.Type;

export const WorkspaceSlug = WorkspaceShortName;

export type WorkspaceSlug = WorkspaceShortName;

export const WorkspaceRole = Schema.Literals([
  "owner",
  "admin",
  "auditor",
  "member",
]);

export type WorkspaceRole = typeof WorkspaceRole.Type;

export const WorkspacePermission = Schema.Literals([
  "workspace:own",
  "workspace:update",
  "usage:read",
  "usage-audit:read",
  "private-threads:inspect",
  "integrations:manage",
  "applications:read",
  "applications:manage",
]);

export type WorkspacePermission = typeof WorkspacePermission.Type;

const permissionsByRole = {
  owner: [
    "workspace:own",
    "workspace:update",
    "usage:read",
    "usage-audit:read",
    "integrations:manage",
    "applications:read",
    "applications:manage",
  ],
  admin: [
    "workspace:update",
    "usage:read",
    "usage-audit:read",
    "integrations:manage",
    "applications:read",
    "applications:manage",
  ],
  auditor: [
    "usage:read",
    "usage-audit:read",
    "private-threads:inspect",
    "applications:read",
  ],
  member: ["applications:read"],
} as const satisfies Record<WorkspaceRole, ReadonlyArray<WorkspacePermission>>;

export const workspacePermissionsForRole = (
  role: WorkspaceRole,
): ReadonlyArray<WorkspacePermission> => permissionsByRole[role];

export const workspaceRoleHasPermission = (
  role: WorkspaceRole,
  permission: WorkspacePermission,
): boolean =>
  (
    workspacePermissionsForRole(role) as ReadonlyArray<WorkspacePermission>
  ).includes(permission);

export const WorkspaceLifecycleState = Schema.Literals([
  "active",
  "deletion-pending",
  "deleting",
  "deletion-failed",
]);

export type WorkspaceLifecycleState = typeof WorkspaceLifecycleState.Type;

export const WorkspaceProfileRevision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

export type WorkspaceProfileRevision = typeof WorkspaceProfileRevision.Type;

export const WorkspaceProfile = Schema.Struct({
  id: WorkspaceId,
  displayName: WorkspaceDisplayName,
  shortName: WorkspaceShortName,
  lifecycleState: WorkspaceLifecycleState,
  revision: WorkspaceProfileRevision,
});

export type WorkspaceProfile = typeof WorkspaceProfile.Type;

export const WorkspaceMembership = Schema.Struct({
  workspace: WorkspaceProfile,
  userId: UserId,
  role: WorkspaceRole,
});

export type WorkspaceMembership = typeof WorkspaceMembership.Type;

export const CreateWorkspaceInput = Schema.Struct({
  displayName: WorkspaceDisplayName,
  shortName: WorkspaceShortName,
});

export type CreateWorkspaceInput = typeof CreateWorkspaceInput.Type;

export const UpdateWorkspaceProfileInput = CreateWorkspaceInput;

export type UpdateWorkspaceProfileInput =
  typeof UpdateWorkspaceProfileInput.Type;

export const normalizeWorkspaceDisplayName = (value: string): string =>
  value.trim();

export const normalizeWorkspaceShortName = (value: string): string =>
  value.trim().toLowerCase();
