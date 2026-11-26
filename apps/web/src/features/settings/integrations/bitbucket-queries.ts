import {
  BeginBitbucketAuthorizationEndpoint,
  DisconnectBitbucketEndpoint,
  type Endpoint,
  GetBitbucketConnectionEndpoint,
  ListBitbucketRepositoriesEndpoint,
  RefreshBitbucketConnectionEndpoint,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { ApiError, dxClient } from "../../../shared/api/client.js";
import { integrationKeys } from "./integration-queries.js";

export class BitbucketApiError extends Schema.TaggedError<BitbucketApiError>()(
  "BitbucketApiError",
  {
    status: Schema.Number,
    code: Schema.String,
    requestId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Calls a Bitbucket endpoint, throwing its typed refusals as
 * BitbucketApiError and anything else as Bitbucket being unavailable.
 */
const request = async <E extends Endpoint>(
  endpoint: E,
  signal?: AbortSignal,
): Promise<E["success"]["Type"]> =>
  dxClient.call(endpoint as Endpoint, {}, { signal }).catch((cause) => {
    if (cause instanceof ApiError && cause.hasValidatedPayload)
      throw new BitbucketApiError({
        status: cause.status,
        code: cause.code ?? "",
        requestId: String(cause.data?.requestId ?? ""),
        message: cause.message,
      });
    if (cause instanceof ApiError)
      throw new Error("Bitbucket is currently unavailable.");
    throw cause;
  });

export interface BitbucketRepository {
  readonly id: string;
  readonly workspaceId: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly visibility: "public" | "private";
  readonly archived: boolean;
}

export const bitbucketKeys = {
  all: (userId: UserId) =>
    [...integrationKeys.personal(userId), "bitbucket"] as const,
  connection: (userId: UserId) =>
    [...bitbucketKeys.all(userId), "connection"] as const,
  repositories: (userId: UserId, connectionId: string) =>
    [...bitbucketKeys.all(userId), "repositories", connectionId] as const,
};

export const bitbucketConnectionQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: bitbucketKeys.connection(userId),
    queryFn: async ({ signal }) =>
      (await request(GetBitbucketConnectionEndpoint, signal)).data,
    staleTime: 30_000,
    retry: false,
  });

export const bitbucketRepositoriesQueryOptions = (
  userId: UserId,
  connectionId?: string,
) =>
  queryOptions({
    queryKey: bitbucketKeys.repositories(userId, connectionId ?? "inactive"),
    queryFn: async ({ signal }) =>
      (await request(ListBitbucketRepositoriesEndpoint, signal)).data,
    enabled: connectionId !== undefined,
    staleTime: 30_000,
    retry: false,
  });

const invalidate = (queryClient: QueryClient, userId: UserId) =>
  queryClient.invalidateQueries({ queryKey: bitbucketKeys.all(userId) });

export const bitbucketAuthorizeMutationOptions = (userId: UserId) =>
  mutationOptions({
    mutationKey: [...bitbucketKeys.all(userId), "authorize"] as const,
    mutationFn: async () =>
      (await request(BeginBitbucketAuthorizationEndpoint)).data
        .authorizationUrl,
  });

export const bitbucketRefreshMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...bitbucketKeys.all(userId), "refresh"] as const,
    mutationFn: async () =>
      (await request(RefreshBitbucketConnectionEndpoint)).data,
    onSuccess: (data) =>
      queryClient.setQueryData(bitbucketKeys.connection(userId), data),
    onSettled: () => invalidate(queryClient, userId),
  });

export const bitbucketDisconnectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...bitbucketKeys.all(userId), "disconnect"] as const,
    mutationFn: () => request(DisconnectBitbucketEndpoint),
    onSettled: () => invalidate(queryClient, userId),
  });
