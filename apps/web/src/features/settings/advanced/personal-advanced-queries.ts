import type { PersonalAgentInstructionsData } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  getPersonalAgentInstructions,
  resetPersonalAgentInstructions,
  updatePersonalAgentInstructions,
} from "../../../shared/api/client.js";

export const personalAdvancedMutationError = (
  cause: unknown,
  fallback: string,
) =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? {
        message: cause.message,
        fieldErrors: cause.fieldErrors,
        currentRevision: cause.currentRevision,
      }
    : { message: fallback, fieldErrors: undefined, currentRevision: undefined };

export const personalAdvancedKeys = {
  instructions: (userId: UserId) =>
    ["personal-advanced", userId, "agent-instructions"] as const,
};

export const personalAgentInstructionsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalAdvancedKeys.instructions(userId),
    queryFn: ({ signal }) => getPersonalAgentInstructions(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

const cacheInstructions = (
  queryClient: QueryClient,
  userId: UserId,
  instructions: PersonalAgentInstructionsData,
) => {
  const queryKey = personalAdvancedKeys.instructions(userId);
  return queryClient
    .cancelQueries({ queryKey, exact: true })
    .then(() => queryClient.setQueryData(queryKey, instructions));
};

export const updatePersonalAgentInstructionsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [
      ...personalAdvancedKeys.instructions(userId),
      "update",
    ] as const,
    mutationFn: updatePersonalAgentInstructions,
    onSuccess: (instructions) =>
      cacheInstructions(queryClient, userId, instructions),
  });

export const resetPersonalAgentInstructionsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [
      ...personalAdvancedKeys.instructions(userId),
      "reset",
    ] as const,
    mutationFn: resetPersonalAgentInstructions,
    onSuccess: (instructions) =>
      cacheInstructions(queryClient, userId, instructions),
  });
