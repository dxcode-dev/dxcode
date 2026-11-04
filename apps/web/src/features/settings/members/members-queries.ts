import type { UserId, WorkspaceSlug } from "@dx/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  acceptWorkspaceInvite,
  createWorkspaceInviteLink,
  getWorkspaceInvite,
  listWorkspaceInviteLinks,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceInviteLink,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
} from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";
import { workspaceKeys } from "../workspace/workspace-queries.js";

export const memberKeys = {
  all: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...workspaceKeys.detail(userId, workspaceSlug), "members"] as const,
  inviteLinks: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...workspaceKeys.detail(userId, workspaceSlug), "invite-links"] as const,
};

export const workspaceMembersQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
) =>
  queryOptions({
    queryKey: memberKeys.all(userId, workspaceSlug),
    queryFn: ({ signal }) => listWorkspaceMembers(workspaceSlug, signal),
    staleTime: 15_000,
  });

export const workspaceInviteLinksQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
) =>
  queryOptions({
    queryKey: memberKeys.inviteLinks(userId, workspaceSlug),
    queryFn: ({ signal }) => listWorkspaceInviteLinks(workspaceSlug, signal),
    staleTime: 15_000,
  });

export const memberMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
) => {
  const refreshMembers = () =>
    queryClient.invalidateQueries({
      queryKey: memberKeys.all(userId, workspaceSlug),
    });
  const refreshLinks = () =>
    queryClient.invalidateQueries({
      queryKey: memberKeys.inviteLinks(userId, workspaceSlug),
    });
  return {
    setRole: {
      mutationFn: (input: {
        readonly userId: string;
        readonly role: "admin" | "member";
      }) => updateWorkspaceMemberRole(workspaceSlug, input.userId, input.role),
      onSettled: refreshMembers,
    },
    transferOwnership: {
      mutationFn: (memberUserId: string) =>
        transferWorkspaceOwnership(workspaceSlug, memberUserId),
      // The viewer's own role changes too, which every settings page reads.
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: settingsKeys.all(userId) }),
    },
    remove: {
      mutationFn: (memberUserId: string) =>
        removeWorkspaceMember(workspaceSlug, memberUserId),
      onSettled: refreshMembers,
    },
    createLink: {
      mutationFn: (input: {
        readonly title: string;
        readonly expiresAt?: string;
        readonly maxUses?: number;
      }) => createWorkspaceInviteLink(workspaceSlug, input),
      onSettled: refreshLinks,
    },
    revokeLink: {
      mutationFn: (linkId: string) =>
        revokeWorkspaceInviteLink(workspaceSlug, linkId),
      onSettled: refreshLinks,
    },
  };
};

export const workspaceInviteQueryOptions = (token: string) =>
  queryOptions({
    queryKey: ["workspace-invite", token] as const,
    queryFn: ({ signal }) => getWorkspaceInvite(token, signal),
    staleTime: 60_000,
    retry: false,
  });

export const acceptInviteMutationOptions = (token: string) => ({
  mutationFn: () => acceptWorkspaceInvite(token),
});

export interface InviteLinkFieldErrors {
  readonly title?: string;
  readonly expiresAt?: string;
  readonly maxUses?: string;
}

/** The server's per-field messages, when it rejected only the dialog's fields. */
export const inviteLinkFieldErrors = (
  error: unknown,
): InviteLinkFieldErrors | undefined => {
  const errors = error instanceof ApiError ? error.fieldErrors : undefined;
  if (
    errors === undefined ||
    errors.length === 0 ||
    !errors.every(({ field }) =>
      ["title", "expiresAt", "maxUses"].includes(field),
    )
  )
    return undefined;
  return Object.fromEntries(
    errors.map(({ field, message }) => [field, message]),
  );
};
