import type { PersonalComposerDefaultsData } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getPersonalComposerDefaults,
  updatePersonalComposerDefaults,
} from "../../../shared/api/client.js";

export const composerDefaultsKeys = {
  detail: (userId: UserId) => ["personal-composer-defaults", userId] as const,
};

const mutationKey = (userId: UserId) =>
  [...composerDefaultsKeys.detail(userId), "update"] as const;

/** Last New Thread composer choices, shared across the user's devices. */
export const composerDefaultsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: composerDefaultsKeys.detail(userId),
    queryFn: ({ signal }) => getPersonalComposerDefaults(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

/**
 * Remembers one composer change. Writes are serialized, applied to the cache
 * immediately, and last write wins. A failed write only affects what the next
 * composer opens with, so it refetches instead of surfacing an error.
 */
export const updateComposerDefaultsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: mutationKey(userId),
    scope: { id: `personal-composer-defaults:${userId}` },
    mutationFn: updatePersonalComposerDefaults,
    onMutate: async (input) => {
      await queryClient.cancelQueries({
        queryKey: composerDefaultsKeys.detail(userId),
        exact: true,
      });
      queryClient.setQueryData<PersonalComposerDefaultsData>(
        composerDefaultsKeys.detail(userId),
        (current) =>
          current === undefined ? current : { ...current, ...input },
      );
    },
    onSettled: async () => {
      if (
        queryClient.isMutating({
          mutationKey: mutationKey(userId),
          exact: true,
        }) === 1
      )
        await queryClient.invalidateQueries({
          queryKey: composerDefaultsKeys.detail(userId),
          exact: true,
        });
    },
  });
