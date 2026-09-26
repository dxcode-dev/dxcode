import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getPersonalExperimentalFeatures,
  updatePersonalExperimentalFeature,
} from "../../../shared/api/client.js";

export const experimentalFeatureKeys = {
  personal: (userId: UserId) => ["experimental-features", userId] as const,
};

export const personalExperimentalFeaturesQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: experimentalFeatureKeys.personal(userId),
    queryFn: ({ signal }) => getPersonalExperimentalFeatures(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const updatePersonalExperimentalFeatureMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [
      ...experimentalFeatureKeys.personal(userId),
      "update",
    ] as const,
    mutationFn: (input: Parameters<typeof updatePersonalExperimentalFeature>) =>
      updatePersonalExperimentalFeature(...input),
    onSuccess: async (features) => {
      await queryClient.cancelQueries({
        queryKey: experimentalFeatureKeys.personal(userId),
        exact: true,
      });
      queryClient.setQueryData(
        experimentalFeatureKeys.personal(userId),
        features,
      );
    },
  });
