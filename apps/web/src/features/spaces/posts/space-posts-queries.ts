import {
  ListSpacePostsResponseSchema,
  SPACE_POST_REACTIONS,
  SPACE_POSTS_DEFAULT_LIMIT,
  type SpacePost,
  type SpacePostReaction,
  SpacePostResponseSchema,
  type SpacePostRevision,
  SpacePostRevisionsResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { request } from "../../../shared/api/client.js";
import { THREAD_FRESHNESS_SLO_MS } from "../../threads/thread-queries.js";
import { refetchSpacePosts, spaceKeys } from "../space-cache-queries.js";

// The Space's posts: what people and the Space's agent publish in its chat
// (`@dx/api` posts.ts). The agent's text replies and tool calls are never
// posts.

export type { SpacePost, SpacePostReaction, SpacePostRevision };
export { SPACE_POST_REACTIONS };

type SpacePostPage = (typeof ListSpacePostsResponseSchema.Type)["data"];

const PAGE_SIZE = SPACE_POSTS_DEFAULT_LIMIT;

const postsPath = (spaceThreadId: ThreadId, rest = "") =>
  `/v1/spaces/${encodeURIComponent(spaceThreadId)}/posts${rest}`;

const listPosts = async (
  spaceThreadId: ThreadId,
  before: string | undefined,
  signal?: AbortSignal,
): Promise<SpacePostPage> => {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before !== undefined) query.set("before", before);
  return (
    await request(
      postsPath(spaceThreadId, `?${query}`),
      ListSpacePostsResponseSchema,
      { signal },
    )
  ).data;
};

const listRevisions = async (
  spaceThreadId: ThreadId,
  postId: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<SpacePostRevision>> =>
  (
    await request(
      postsPath(spaceThreadId, `/${encodeURIComponent(postId)}/revisions`),
      SpacePostRevisionsResponseSchema,
      { signal },
    )
  ).data.items;

const createPost = async (
  spaceThreadId: ThreadId,
  text: string,
): Promise<SpacePost> =>
  (
    await request(postsPath(spaceThreadId), SpacePostResponseSchema, {
      method: "POST",
      body: JSON.stringify({ text }),
    })
  ).data.post;

const editPost = async (
  spaceThreadId: ThreadId,
  postId: string,
  text: string,
): Promise<SpacePost> =>
  (
    await request(
      postsPath(spaceThreadId, `/${encodeURIComponent(postId)}`),
      SpacePostResponseSchema,
      { method: "PATCH", body: JSON.stringify({ text }) },
    )
  ).data.post;

const setReaction = async (
  spaceThreadId: ThreadId,
  postId: string,
  reaction: SpacePostReaction,
  on: boolean,
): Promise<SpacePost> =>
  (
    await request(
      postsPath(
        spaceThreadId,
        `/${encodeURIComponent(postId)}/reactions/${reaction}`,
      ),
      SpacePostResponseSchema,
      { method: on ? "PUT" : "DELETE" },
    )
  ).data.post;

export const spacePostKeys = {
  /** The Space's posts; under its detail key, so realtime refreshes them. */
  posts: spaceKeys.posts,
  revisions: (userId: UserId, spaceThreadId: ThreadId, postId: string) =>
    [
      ...spaceKeys.detail(userId, spaceThreadId),
      "post-revisions",
      postId,
    ] as const,
};

/**
 * The Space's chat, newest page first: each page holds posts oldest first,
 * and the next page reads the posts before the oldest one loaded.
 */
export const spacePostsQueryOptions = (
  userId: UserId,
  spaceThreadId: ThreadId,
) =>
  infiniteQueryOptions({
    queryKey: spacePostKeys.posts(userId, spaceThreadId),
    queryFn: ({ pageParam, signal }) =>
      listPosts(spaceThreadId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    // Realtime refreshes the posts as they change; this covers a missed hint.
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
  });

/** A post's earlier versions, oldest first. */
export const spacePostRevisionsQueryOptions = (
  userId: UserId,
  spaceThreadId: ThreadId,
  postId: string,
) =>
  queryOptions({
    queryKey: spacePostKeys.revisions(userId, spaceThreadId, postId),
    queryFn: ({ signal }) => listRevisions(spaceThreadId, postId, signal),
    staleTime: 30_000,
  });

/** Every loaded post, oldest first. */
export const flattenSpacePosts = (
  data: { readonly pages: ReadonlyArray<SpacePostPage> } | undefined,
): ReadonlyArray<SpacePost> =>
  data === undefined
    ? []
    : data.pages.toReversed().flatMap(({ items }) => items);

type PostsCache = InfiniteData<SpacePostPage, string | undefined>;

/** Applies `change` to the cached post `postId`, wherever it is loaded. */
const updateCachedPost = (
  client: QueryClient,
  key: ReturnType<typeof spacePostKeys.posts>,
  postId: string,
  change: (post: SpacePost) => SpacePost,
) =>
  client.setQueryData<PostsCache>(key, (current) =>
    current === undefined
      ? current
      : {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((post) =>
              post.id === postId ? change(post) : post,
            ),
          })),
        },
  );

/** The newest page gains a post the server confirmed. */
const appendCachedPost = (
  client: QueryClient,
  key: ReturnType<typeof spacePostKeys.posts>,
  post: SpacePost,
) =>
  client.setQueryData<PostsCache>(key, (current) => {
    if (current === undefined) return current;
    if (
      current.pages.some(({ items }) => items.some(({ id }) => id === post.id))
    )
      return current;
    const [newest, ...older] = current.pages;
    return newest === undefined
      ? current
      : {
          ...current,
          pages: [{ ...newest, items: [...newest.items, post] }, ...older],
        };
  });

/** What the composer sends: the post's text, and the draft it came from. */
export interface SpacePostDraft {
  /** As it posts, with each picked person's mention. */
  readonly text: string;
  /** As the person wrote it, to put back in the box if the post fails. */
  readonly draft: string;
}

/**
 * A person posts in the Space's chat; dx reads it from there. Posts sent
 * while one is still sending wait their turn and go in order (one mutation
 * scope per Space), so Enter is never ignored and nothing posts twice. A
 * post that fails hands its draft to `onFailed`.
 */
export const useCreateSpacePost = (
  userId: UserId,
  spaceThreadId: ThreadId,
  onFailed?: (draft: string) => void,
) => {
  const client = useQueryClient();
  const key = spacePostKeys.posts(userId, spaceThreadId);
  return useMutation({
    mutationKey: [...key, "create"],
    scope: { id: `space-posts:${userId}:${spaceThreadId}` },
    mutationFn: (input: SpacePostDraft) =>
      createPost(spaceThreadId, input.text),
    onSuccess: (post) => {
      appendCachedPost(client, key, post);
      refetchSpacePosts(client, userId, spaceThreadId);
    },
    onError: (_error, input) => onFailed?.(input.draft),
  });
};

/** A post the viewer sent that is still sending or waiting its turn. */
export interface PendingSpacePost {
  readonly key: number;
  /** As the person wrote it. */
  readonly text: string;
  /** As it posts. */
  readonly posted: string;
  readonly submittedAt: number;
}

/**
 * Posts the viewer sent that the server has not taken yet, oldest first:
 * the one sending and any waiting behind it.
 */
export const usePendingSpacePosts = (
  userId: UserId,
  spaceThreadId: ThreadId,
): ReadonlyArray<PendingSpacePost> =>
  useMutationState({
    filters: {
      mutationKey: [...spacePostKeys.posts(userId, spaceThreadId), "create"],
      status: "pending",
    },
    select: (mutation) => {
      const input = mutation.state.variables as SpacePostDraft | undefined;
      return {
        key: mutation.mutationId,
        text: input?.draft ?? "",
        posted: input?.text ?? "",
        submittedAt: mutation.state.submittedAt,
      };
    },
  });

/** A person edits their own post; its earlier text stays as a revision. */
export const useEditSpacePost = (userId: UserId, spaceThreadId: ThreadId) => {
  const client = useQueryClient();
  const key = spacePostKeys.posts(userId, spaceThreadId);
  return useMutation({
    mutationKey: [...key, "edit"],
    mutationFn: (input: { readonly postId: string; readonly text: string }) =>
      editPost(spaceThreadId, input.postId, input.text),
    onSuccess: (post) => {
      updateCachedPost(client, key, post.id, () => post);
      void client.invalidateQueries({
        queryKey: spacePostKeys.revisions(userId, spaceThreadId, post.id),
      });
    },
  });
};

/** The viewer's reaction toggled on a post's counts. */
const toggledReactions = (
  post: SpacePost,
  reaction: SpacePostReaction,
  on: boolean,
): SpacePost["reactions"] => {
  const existing = post.reactions.find((item) => item.reaction === reaction);
  if (existing === undefined)
    return on
      ? [...post.reactions, { reaction, count: 1, mine: true, agent: false }]
      : post.reactions;
  if (existing.mine === on) return post.reactions;
  return post.reactions.flatMap((item) => {
    if (item.reaction !== reaction) return [item];
    const count = item.count + (on ? 1 : -1);
    return count <= 0 ? [] : [{ ...item, count, mine: on }];
  });
};

/**
 * Adds or removes the viewer's reaction. The count changes at once; a
 * failure puts the server's counts back.
 */
export const useSetSpacePostReaction = (
  userId: UserId,
  spaceThreadId: ThreadId,
) => {
  const client = useQueryClient();
  const key = spacePostKeys.posts(userId, spaceThreadId);
  return useMutation({
    mutationKey: [...key, "react"],
    mutationFn: (input: {
      readonly postId: string;
      readonly reaction: SpacePostReaction;
      readonly on: boolean;
    }) => setReaction(spaceThreadId, input.postId, input.reaction, input.on),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key });
      updateCachedPost(client, key, input.postId, (post) => ({
        ...post,
        reactions: toggledReactions(post, input.reaction, input.on),
      }));
    },
    onSuccess: (post) => updateCachedPost(client, key, post.id, () => post),
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
};
