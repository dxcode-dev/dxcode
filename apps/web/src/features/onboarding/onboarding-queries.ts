import {
  type OnboardingData,
  type OnboardingMilestone,
  OnboardingResponseSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";

const getOnboarding = async (signal?: AbortSignal) =>
  (await request("/v1/onboarding", OnboardingResponseSchema, { signal })).data;

const putOnboarding = async (done: OnboardingMilestone) =>
  (
    await request("/v1/onboarding", OnboardingResponseSchema, {
      method: "PUT",
      body: JSON.stringify({ done }),
    })
  ).data;

export const onboardingKeys = {
  progress: (userId: UserId) => ["onboarding", userId] as const,
};

/**
 * The person's onboarding progress. It changes only through this person's
 * own actions; focus covers a change made on another device.
 */
export const onboardingQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: onboardingKeys.progress(userId),
    queryFn: ({ signal }) => getOnboarding(signal),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: "always",
  });

const MILESTONE_FIELD = {
  setup: "setupFinishedAt",
  tour: "tourFinishedAt",
  checklist: "checklistHiddenAt",
} as const satisfies Record<OnboardingMilestone, keyof OnboardingData>;

/** Marks setup, the tour, or the checklist done; the response is the progress. */
export const markOnboardingMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: ["onboarding", userId, "mark"],
    mutationFn: (done: OnboardingMilestone) => putOnboarding(done),
    // Done at once, so leaving setup for home doesn't bounce back to it.
    onMutate: (done: OnboardingMilestone) => {
      const field = MILESTONE_FIELD[done];
      queryClient.setQueryData(
        onboardingKeys.progress(userId),
        (progress: OnboardingData | undefined) =>
          progress === undefined
            ? progress
            : {
                ...progress,
                [field]: progress[field] ?? new Date().toISOString(),
              },
      );
    },
    onSuccess: (progress: OnboardingData) =>
      queryClient.setQueryData(onboardingKeys.progress(userId), progress),
  });

/** A new account that hasn't finished or skipped setup yet. */
export const setupPending = (progress: OnboardingData | undefined) =>
  progress !== undefined && progress.setupFinishedAt === null;
