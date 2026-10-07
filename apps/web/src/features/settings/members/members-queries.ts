import type { UserId, WorkspaceSlug } from "@dx/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import {
  acceptWorkspaceInvite,
  createWorkspaceInviteLink,
  getWorkspaceInvite,
  listWorkspaceInviteLinks,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceInviteLink,
  updateWorkspaceMemberRole,
} from "../../../shared/api/client.js";
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
    remove: {
      mutationFn: (memberUserId: string) =>
        removeWorkspaceMember(workspaceSlug, memberUserId),
      onSettled: refreshMembers,
    },
    createLink: {
      mutationFn: (input: {
        readonly title: string;
        readonly expiresAt?: string;
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

const INVITE_PATH = /^\/join\/([A-Za-z0-9_-]{43})$/;

/** The invite token in a `/join/<token>` path, if any. */
export const inviteTokenFromPath = (pathname: string) =>
  INVITE_PATH.exec(pathname)?.[1];

export const acceptInviteMutationOptions = (token: string) => ({
  mutationFn: () => acceptWorkspaceInvite(token),
});
