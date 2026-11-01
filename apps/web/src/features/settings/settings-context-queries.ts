import type { UserId, WorkspaceSlug } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, getSettingsContext } from "../../shared/api/client.js";

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
 * exist, was renamed away, or the user is not a member. It answers all three
 * alike, so it does not reveal which workspaces exist.
 */
export const isMissingWorkspaceError = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);
