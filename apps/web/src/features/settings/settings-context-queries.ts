import {
  GetSettingsContextEndpoint,
  GetWorkspaceProfileEndpoint,
  type SettingsContextData,
  type WorkspaceProfileData,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, dxClient } from "../../shared/api/client.js";

const getWorkspaceProfile = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
): Promise<WorkspaceProfileData> =>
  (
    await dxClient.call(
      GetWorkspaceProfileEndpoint,
      { params: { workspaceSlug } },
      { signal },
    )
  ).data;

const getSettingsContext = async (
  input: SettingsContextScope,
  signal?: AbortSignal,
): Promise<SettingsContextData> => {
  if (input.scope === "personal") {
    return (await dxClient.call(GetSettingsContextEndpoint, {}, { signal }))
      .data;
  }
  return {
    activeScope: "workspace",
    workspace: await getWorkspaceProfile(input.workspaceSlug, signal),
  };
};

export type SettingsContextScope =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export const settingsKeys = {
  all: (userId: UserId) => ["settings", userId] as const,
  contexts: (userId: UserId) =>
    [...settingsKeys.all(userId), "context"] as const,
  context: (userId: UserId, target: SettingsContextScope) =>
    target.scope === "personal"
      ? ([...settingsKeys.contexts(userId), "personal"] as const)
      : ([
          ...settingsKeys.contexts(userId),
          "workspace",
          target.workspaceSlug,
        ] as const),
};

export const settingsContextQueryOptions = (
  userId: UserId,
  target: SettingsContextScope = { scope: "personal" },
) =>
  queryOptions({
    queryKey: settingsKeys.context(userId, target),
    queryFn: ({ signal }) => getSettingsContext(target, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

/**
 * The server answered that the user cannot open this workspace: it does not
 * exist, its former name was taken by another workspace, or the user is not a
 * member. It answers all three alike, so it does not reveal which workspaces
 * exist.
 */
export const isMissingWorkspaceError = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);
