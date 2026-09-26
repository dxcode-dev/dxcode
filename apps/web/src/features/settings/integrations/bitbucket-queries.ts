import {
  BeginBitbucketAuthorizationResponseSchema,
  BitbucketConnectionResponseSchema,
  BitbucketDisconnectResponseSchema,
  BitbucketForbiddenResponseSchema,
  BitbucketInvalidResponseSchema,
  BitbucketRepositoriesResponseSchema,
  BitbucketUnavailableResponseSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { integrationKeys } from "./integration-queries.js";

const base = "/v1/integrations/bitbucket/personal";

export class BitbucketApiError extends Schema.TaggedError<BitbucketApiError>()(
  "BitbucketApiError",
  {
    status: Schema.Number,
    code: Schema.String,
    requestId: Schema.String,
    message: Schema.String,
  },
) {}

const decodeError = async (body: unknown) => {
  for (const schema of [
    BitbucketUnavailableResponseSchema,
    BitbucketInvalidResponseSchema,
    BitbucketForbiddenResponseSchema,
  ]) {
    const decoded = await Schema.decodeUnknownPromise(schema)(body).catch(
      () => undefined,
    );
    if (decoded !== undefined) return decoded;
  }
  return undefined;
};

const request = async <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await sameOriginFetch(path, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const decoded = await decodeError(body);
    if (decoded !== undefined)
      throw new BitbucketApiError({
        status: response.status,
        code: decoded.data.code,
        requestId: decoded.data.requestId,
        message: decoded.data.message,
      });
    throw new Error("Bitbucket is currently unavailable.");
  }
  return Schema.decodeUnknownPromise(schema)(body);
};

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
      (
        await request(`${base}/connection`, BitbucketConnectionResponseSchema, {
          signal,
        })
      ).data,
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
      (
        await request(
          `${base}/repositories`,
          BitbucketRepositoriesResponseSchema,
          {
            signal,
          },
        )
      ).data,
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
      (
        await request(
          `${base}/authorize`,
          BeginBitbucketAuthorizationResponseSchema,
          {
            method: "POST",
          },
        )
      ).data.authorizationUrl,
  });

export const bitbucketRefreshMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...bitbucketKeys.all(userId), "refresh"] as const,
    mutationFn: async () =>
      (
        await request(`${base}/refresh`, BitbucketConnectionResponseSchema, {
          method: "POST",
        })
      ).data,
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
    mutationFn: () =>
      request(`${base}/connection`, BitbucketDisconnectResponseSchema, {
        method: "DELETE",
      }),
    onSettled: () => invalidate(queryClient, userId),
  });
