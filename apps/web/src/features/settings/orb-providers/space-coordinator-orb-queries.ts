import {
  GetPersonalSpaceCoordinatorOrbEndpoint,
  GetWorkspaceSpaceCoordinatorOrbEndpoint,
  UpdatePersonalSpaceCoordinatorOrbEndpoint,
  UpdateWorkspaceSpaceCoordinatorOrbEndpoint,
} from "@dx/api";
import type { RunnerProfileId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";
import type { PluginsTarget } from "../plugins/plugins-queries.js";

/** Settings → Orb Providers → Space coordinator: its read and write. */

const read = async (target: PluginsTarget, signal: AbortSignal) =>
  (target.scope === "personal"
    ? await dxClient.call(
        GetPersonalSpaceCoordinatorOrbEndpoint,
        {},
        { signal },
      )
    : await dxClient.call(
        GetWorkspaceSpaceCoordinatorOrbEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

const save = async (
  target: PluginsTarget,
  runnerProfileId: RunnerProfileId | null,
) =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalSpaceCoordinatorOrbEndpoint, {
        body: { runnerProfileId },
      })
    : await dxClient.call(UpdateWorkspaceSpaceCoordinatorOrbEndpoint, {
        params: { workspaceSlug: target.workspaceSlug },
        body: { runnerProfileId },
      })
  ).data;

const keys = (userId: UserId, target: PluginsTarget) =>
  ["space-coordinator-orb", userId, target] as const;

export const spaceCoordinatorOrbQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: keys(userId, target),
    queryFn: ({ signal }) => read(target, signal),
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
    mutationFn: (runnerProfileId: RunnerProfileId | null) =>
      save(target, runnerProfileId),
    onSuccess: (data) => {
      queryClient.setQueryData(keys(userId, target), data);
      // The other scope's "what applies" may change with this one.
      return queryClient.invalidateQueries({
        queryKey: ["space-coordinator-orb", userId],
      });
    },
  });
