import {
  type CreateSpaceRequest,
  ListSpaceSuggestionsResponseSchema,
  ListSpacesResponseSchema,
  ListSpaceThreadsResponseSchema,
  type SpaceArtifactItem,
  SpaceArtifactsResponseSchema,
  type SpaceData,
  SpaceResponseSchema,
  type SpaceSuggestion,
  type SpaceThreadItem,
  type UpdateSpaceRequest,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import {
  invalidateThreadQueries,
  THREAD_FRESHNESS_SLO_MS,
} from "../threads/thread-queries.js";

import { spaceKeys } from "./space-cache-queries.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;

// The Spaces requests live here, not in the shared client, so they load
// with the Spaces UI rather than on the Thread page's first load.

/** Creates a Space: a root Thread its agent coordinates work in. */
const createSpace = async (input: CreateSpaceRequest): Promise<SpaceData> =>
  (
    await request("/v1/spaces", SpaceResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data.space;

/** The Spaces the requester created or joined, most recent activity first. */
const listSpaces = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceData>> =>
  (await request("/v1/spaces", ListSpacesResponseSchema, { signal })).data
    .items;

/** Spaces shared with the requester's workspace that they have not joined. */
const discoverSpaces = async (
  query: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceData>> =>
  (
    await request(
      query.trim() === ""
        ? "/v1/spaces/discover"
        : `/v1/spaces/discover?q=${encodeURIComponent(query.trim())}`,
      ListSpacesResponseSchema,
      { signal },
    )
  ).data.items;

const getSpace = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<SpaceData> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}`,
      SpaceResponseSchema,
      { signal },
    )
  ).data.space;

/** The owner edits a Space's name, goal, color, or sharing. */
const updateSpace = async (
  threadId: ThreadId,
  input: UpdateSpaceRequest,
): Promise<SpaceData> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}`,
      SpaceResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data.space;

/** Spaces dx proposes from the person's recent threads, for New Space. */
const listSpaceSuggestions = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceSuggestion>> =>
  (
    await request(
      "/v1/spaces/suggestions",
      ListSpaceSuggestionsResponseSchema,
      { signal },
    )
  ).data.items;

/** Joins or leaves a Space, which lists it in the sidebar or takes it out. */
const setSpaceJoined = async (
  threadId: ThreadId,
  joined: boolean,
): Promise<SpaceData> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}/${joined ? "join" : "leave"}`,
      SpaceResponseSchema,
      { method: "POST" },
    )
  ).data.space;

/** The threads a Space started, newest first. */
const listSpaceThreads = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceThreadItem>> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}/threads`,
      ListSpaceThreadsResponseSchema,
      { signal },
    )
  ).data.items;

/** The artifacts of the Space and the threads it started, the Space's first. */
const listSpaceArtifacts = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceArtifactItem>> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}/artifacts`,
      SpaceArtifactsResponseSchema,
      { signal },
    )
  ).data.items;

export const joinedSpacesQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: spaceKeys.joined(userId),
    queryFn: ({ signal }) => listSpaces(signal),
    staleTime,
    gcTime,
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

export const discoverSpacesQueryOptions = (userId: UserId, query: string) =>
  queryOptions({
    queryKey: spaceKeys.discover(userId, query),
    queryFn: ({ signal }) => discoverSpaces(query, signal),
    staleTime,
    gcTime,
  });

/**
 * One model call groups the recent threads, so the answer stays for the
 * dialog's life and a few minutes after, and a failure is not retried.
 */
export const spaceSuggestionsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: spaceKeys.suggestions(userId),
    queryFn: ({ signal }) => listSpaceSuggestions(signal),
    staleTime: 5 * 60_000,
    gcTime,
    retry: false,
    refetchOnWindowFocus: false,
  });

export const spaceQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: spaceKeys.detail(userId, threadId),
    queryFn: ({ signal }) => getSpace(threadId, signal),
    staleTime,
    gcTime,
  });

export const spaceThreadsQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: spaceKeys.threads(userId, threadId),
    queryFn: ({ signal }) => listSpaceThreads(threadId, signal),
    staleTime,
    gcTime,
  });

export const spaceArtifactsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: spaceKeys.artifacts(userId, threadId),
    queryFn: ({ signal }) => listSpaceArtifacts(threadId, signal),
    staleTime,
    gcTime,
  });

/**
 * Applies a Space the server returned to every cached copy of it. The lists
 * refresh in the background: a mutation settles, and its dialog moves on,
 * without waiting for them.
 */
const applySpace = (client: QueryClient, userId: UserId, space: SpaceData) => {
  client.setQueryData(spaceKeys.detail(userId, space.threadId), space);
  return Promise.all([
    client.invalidateQueries({ queryKey: spaceKeys.joined(userId) }),
    client.invalidateQueries({
      queryKey: [...spaceKeys.all(userId), "discover"],
    }),
    invalidateThreadQueries(client, userId, space.threadId),
  ]);
};

export const useCreateSpace = (userId: UserId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...spaceKeys.all(userId), "create"],
    mutationFn: (input: CreateSpaceRequest) => createSpace(input),
    onSuccess: (space) => {
      void applySpace(client, userId, space);
    },
  });
};

export const useSetSpaceJoined = (userId: UserId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...spaceKeys.all(userId), "join"],
    mutationFn: (input: {
      readonly threadId: ThreadId;
      readonly joined: boolean;
    }) => setSpaceJoined(input.threadId, input.joined),
    onSuccess: (space) => {
      void applySpace(client, userId, space);
    },
  });
};

export const useUpdateSpace = (userId: UserId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...spaceKeys.all(userId), "update"],
    mutationFn: (input: {
      readonly threadId: ThreadId;
      readonly update: UpdateSpaceRequest;
    }) => updateSpace(input.threadId, input.update),
    onSuccess: (space) => {
      void applySpace(client, userId, space);
    },
  });
};
