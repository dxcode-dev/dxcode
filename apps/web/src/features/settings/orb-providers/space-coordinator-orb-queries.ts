import { SpaceCoordinatorOrbResponseSchema } from "@dx/api";
import type { RunnerProfileId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  type PluginsTarget,
  request,
} from "../../../shared/api/client.js";

/** Settings → Orb Providers → Space coordinator: its read and write. */

const path = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/space-coordinator-orb"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/space-coordinator-orb`;

const keys = (userId: UserId, target: PluginsTarget) =>
  ["space-coordinator-orb", userId, target] as const;

export const spaceCoordinatorOrbQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: keys(userId, target),
    queryFn: async ({ signal }) =>
      (
        await request(path(target), SpaceCoordinatorOrbResponseSchema, {
          signal,
        })
      ).data,
    // A deployment with Spaces off answers SPACES_UNAVAILABLE: no card.
    retry: (count, error) =>
      !(error instanceof ApiError && error.status < 500) && count < 2,
    staleTime: 30_000,
  });

/** Why a save failed, as the API explained it, or a fallback. */
export const spaceCoordinatorOrbErrorMessage = (
  error: unknown,
  fallback: string,
) => (error instanceof ApiError ? error.message : fallback);

export const spaceCoordinatorOrbSaveOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationFn: async (runnerProfileId: RunnerProfileId | null) =>
      (
        await request(path(target), SpaceCoordinatorOrbResponseSchema, {
          method: "PUT",
          body: JSON.stringify({ runnerProfileId }),
        })
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(keys(userId, target), data);
      // The other scope's "what applies" may change with this one.
      return queryClient.invalidateQueries({
        queryKey: ["space-coordinator-orb", userId],
      });
    },
  });
