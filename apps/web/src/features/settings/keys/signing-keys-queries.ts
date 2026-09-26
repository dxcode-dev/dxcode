import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  addVerificationKey,
  createManagedSigningKey,
  getSigningKeys,
  revokeManagedSigningKey,
  revokeVerificationKey,
  rotateManagedSigningKey,
} from "../../../shared/api/client.js";

export const signingKeyKeys = {
  personal: (userId: UserId) => ["signing-keys", userId] as const,
};

export const signingKeysQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: signingKeyKeys.personal(userId),
    queryFn: ({ signal }) => getSigningKeys(signal),
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });

const invalidatingMutation = <Variables, Result>(
  queryClient: QueryClient,
  userId: UserId,
  action: string,
  mutationFn: (variables: Variables) => Promise<Result>,
) =>
  mutationOptions({
    mutationKey: [...signingKeyKeys.personal(userId), action] as const,
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: signingKeyKeys.personal(userId),
      }),
  });

export const createManagedSigningKeyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  invalidatingMutation(queryClient, userId, "create-managed", () =>
    createManagedSigningKey(),
  );
export const rotateManagedSigningKeyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  invalidatingMutation(
    queryClient,
    userId,
    "rotate-managed",
    rotateManagedSigningKey,
  );
export const revokeManagedSigningKeyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  invalidatingMutation(
    queryClient,
    userId,
    "revoke-managed",
    revokeManagedSigningKey,
  );
export const addVerificationKeyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  invalidatingMutation(
    queryClient,
    userId,
    "add-verification",
    addVerificationKey,
  );
export const revokeVerificationKeyMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  invalidatingMutation(
    queryClient,
    userId,
    "revoke-verification",
    revokeVerificationKey,
  );
