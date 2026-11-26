import {
  AddVerificationKeyEndpoint,
  CreateManagedSigningKeyEndpoint,
  GetSigningKeysEndpoint,
  RevokeManagedSigningKeyEndpoint,
  RevokeVerificationKeyEndpoint,
  RotateManagedSigningKeyEndpoint,
  type SigningKeySetupGuidance,
  type SigningKeysData,
} from "@dx/api";
import type { SigningKeyId, UserId, VerificationKeyId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

const getSigningKeys = async (signal?: AbortSignal): Promise<SigningKeysData> =>
  (await dxClient.call(GetSigningKeysEndpoint, {}, { signal })).data;

const createManagedSigningKey = async (): Promise<{
  readonly key: NonNullable<SigningKeysData["managedKey"]>;
  readonly setup: SigningKeySetupGuidance;
}> => (await dxClient.call(CreateManagedSigningKeyEndpoint, { body: {} })).data;

const rotateManagedSigningKey = async (signingKeyId: SigningKeyId) =>
  (
    await dxClient.call(RotateManagedSigningKeyEndpoint, {
      params: { signingKeyId },
      body: {},
    })
  ).data;

const revokeManagedSigningKey = async (signingKeyId: SigningKeyId) =>
  (
    await dxClient.call(RevokeManagedSigningKeyEndpoint, {
      params: { signingKeyId },
    })
  ).data.revokedSigningKeyId;

const addVerificationKey = async (input: {
  readonly name: string;
  readonly publicKey: string;
}) => (await dxClient.call(AddVerificationKeyEndpoint, { body: input })).data;

const revokeVerificationKey = async (verificationKeyId: VerificationKeyId) =>
  (
    await dxClient.call(RevokeVerificationKeyEndpoint, {
      params: { verificationKeyId },
    })
  ).data.revokedVerificationKeyId;

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
