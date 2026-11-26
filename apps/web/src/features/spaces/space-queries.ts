import {
  CreateSpaceEndpoint,
  type CreateSpaceRequest,
  DiscoverSpacesEndpoint,
  GetSpaceEndpoint,
  JoinSpaceEndpoint,
  LeaveSpaceEndpoint,
  ListSpaceArtifactsEndpoint,
  ListSpaceSuggestionsEndpoint,
  ListSpacesEndpoint,
  ListSpaceThreadsEndpoint,
  type SpaceArtifactItem,
  type SpaceData,
  type SpaceSuggestion,
  type SpaceThreadItem,
  UpdateSpaceEndpoint,
  type UpdateSpaceRequest,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import { ApiError, dxClient } from "../../shared/api/client.js";
import {
  invalidateThreadQueries,
  THREAD_FRESHNESS_SLO_MS,
} from "../threads/thread-queries.js";

import {
  lifecycleOf,
  requestedChanges,
  type Unseen,
} from "../threads/thread-requested-change-queries.js";
import { spaceKeys } from "./space-cache-queries.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;

// The Spaces requests live here, not in the shared client, so they load
// with the Spaces UI rather than on the Thread page's first load.

/** Creates a Space: a root Thread its agent coordinates work in. */
const createSpace = async (input: CreateSpaceRequest): Promise<SpaceData> =>
  (await dxClient.call(CreateSpaceEndpoint, { body: input })).data.space;

/** The Spaces the requester created or joined, most recent activity first. */
const listSpaces = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceData>> =>
  (await dxClient.call(ListSpacesEndpoint, {}, { signal })).data.items;

/** Spaces shared with the requester's workspace that they have not joined. */
const discoverSpaces = async (
  query: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceData>> =>
  (
    await dxClient.call(
      DiscoverSpacesEndpoint,
      { query: query.trim() === "" ? {} : { q: query.trim() } },
      { signal },
    )
  ).data.items;

const getSpace = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<SpaceData> =>
  (await dxClient.call(GetSpaceEndpoint, { params: { threadId } }, { signal }))
    .data.space;

/**
 * Sharing a private Space was held back because its agents read Mail mail
 * members would see; saving again with `acknowledgeMailReads` agrees.
 */
export const isSpaceMailReadsRefusal = (error: unknown) =>
  error instanceof ApiError && error.code === "SPACE_SHARING_MAIL_READS";

/** The owner edits a Space's name, goal, color, or sharing. */
const updateSpace = async (
  threadId: ThreadId,
  input: UpdateSpaceRequest,
): Promise<SpaceData> =>
  (
    await dxClient.call(UpdateSpaceEndpoint, {
      params: { threadId },
      body: input,
    })
  ).data.space;

/** Spaces dx proposes from the person's recent threads, for New Space. */
const listSpaceSuggestions = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceSuggestion>> =>
  (await dxClient.call(ListSpaceSuggestionsEndpoint, {}, { signal })).data
    .items;

/** Joins or leaves a Space, which lists it in the sidebar or takes it out. */
const setSpaceJoined = async (
  threadId: ThreadId,
  joined: boolean,
): Promise<SpaceData> =>
  (
    await dxClient.call(joined ? JoinSpaceEndpoint : LeaveSpaceEndpoint, {
      params: { threadId },
    })
  ).data.space;

/** The threads a Space started, newest first. */
const listSpaceThreads = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceThreadItem>> =>
  (
    await dxClient.call(
      ListSpaceThreadsEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data.items;

/** The artifacts of the Space and the threads it started, the Space's first. */
const listSpaceArtifacts = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpaceArtifactItem>> =>
  (
    await dxClient.call(
      ListSpaceArtifactsEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data.items;

/**
 * The person's Spaces with the archives and restores a read may predate: an
 * archived Space leaves the list, a restored one returns, from the list or
 * the Space as the page last held it.
 */
export const spacesWithChanges = (
  spaces: ReadonlyArray<SpaceData>,
  unseen: Unseen,
  cachedSpace: (threadId: ThreadId) => SpaceData | undefined,
): ReadonlyArray<SpaceData> => {
  let next = spaces;
  for (const [threadId, changes] of unseen) {
    const lifecycleState = lifecycleOf(changes);
    if (lifecycleState === "archived")
      next = next.filter((space) => space.threadId !== threadId);
    if (
      lifecycleState === "active" &&
      !next.some((space) => space.threadId === threadId)
    ) {
      const space = cachedSpace(threadId);
      if (space !== undefined)
        next = placedSpace(next, { ...space, lifecycleState });
    }
  }
  return next;
};

/** The Space with the lifecycle a read may predate. */
export const spaceWithChanges = (space: SpaceData, unseen: Unseen) => {
  const lifecycleState = lifecycleOf(unseen.get(space.threadId) ?? []);
  return lifecycleState === undefined ? space : { ...space, lifecycleState };
};

/** Puts a Space at its place among the person's Spaces: newest activity first. */
const placedSpace = (
  spaces: ReadonlyArray<SpaceData>,
  space: SpaceData,
): ReadonlyArray<SpaceData> => {
  const others = spaces.filter(({ threadId }) => threadId !== space.threadId);
  const at = others.findIndex(
    (other) =>
      DateTime.toEpochMillis(other.lastActivityAt) <
      DateTime.toEpochMillis(space.lastActivityAt),
  );
  return at === -1
    ? [...others, space]
    : [...others.slice(0, at), space, ...others.slice(at)];
};

export const joinedSpacesQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: spaceKeys.joined(userId),
    // A read can predate a Space archived or restored on this page.
    queryFn: ({ client, signal }) =>
      requestedChanges(client).read(
        () => listSpaces(signal),
        (spaces, unseen) =>
          spacesWithChanges(
            spaces,
            unseen,
            (threadId) =>
              client
                .getQueryData<ReadonlyArray<SpaceData>>(
                  spaceKeys.joined(userId),
                )
                ?.find((space) => space.threadId === threadId) ??
              client.getQueryData<SpaceData>(
                spaceKeys.detail(userId, threadId),
              ),
          ),
      ),
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
    queryFn: ({ client, signal }) =>
      requestedChanges(client).read(
        () => getSpace(threadId, signal),
        spaceWithChanges,
      ),
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
