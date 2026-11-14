import type { CreateThreadArtifactCommentRequest } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { threadMembersQueryOptions } from "../threads/sharing/thread-chat-queries.js";
import type { ArtifactScope } from "./artifact-scope.js";
import { scopeThread } from "./artifact-scope.js";
import {
  createArtifactComment,
  getStandaloneArtifactMembers,
  listArtifactComments,
  resolveArtifactComment,
} from "./artifacts-api.js";
import { artifactKeys } from "./artifacts-queries.js";

export const artifactCommentsOptions = (
  threadId: ArtifactScope,
  artifactId: string,
  active = true,
) =>
  queryOptions({
    queryKey: artifactKeys.comments(threadId, artifactId),
    queryFn: ({ signal }) => listArtifactComments(threadId, artifactId, signal),
    enabled: active,
    staleTime: 10_000,
    retry: 2,
  });

/** A comment or reply changes the list and the artifact's open count. */
const refresh = (
  client: QueryClient,
  threadId: ArtifactScope,
  artifactId: string,
) =>
  Promise.all([
    client.invalidateQueries({
      queryKey: artifactKeys.comments(threadId, artifactId),
    }),
    client.invalidateQueries(
      { queryKey: artifactKeys.list(threadId) },
      { cancelRefetch: false },
    ),
  ]);

export const createArtifactCommentMutation = (
  client: QueryClient,
  threadId: ArtifactScope,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: (input: CreateThreadArtifactCommentRequest) =>
      createArtifactComment(threadId, artifactId, input),
    onSuccess: () => refresh(client, threadId, artifactId),
  });

export const resolveArtifactCommentMutation = (
  client: QueryClient,
  threadId: ArtifactScope,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: (commentId: string) =>
      resolveArtifactComment(threadId, artifactId, commentId),
    onSuccess: () => refresh(client, threadId, artifactId),
  });

/**
 * The people `@` lists on an artifact: its Thread's members, or the
 * members a standalone artifact is shared with.
 */
export const artifactMembersOptions = (
  viewerId: UserId,
  threadId: ArtifactScope,
) => {
  const thread = scopeThread(threadId);
  return thread === undefined
    ? queryOptions({
        ...threadMembersQueryOptions(viewerId, threadId as ThreadId),
        queryFn: ({ signal }) =>
          getStandaloneArtifactMembers(
            threadId.slice("artifact:".length),
            signal,
          ),
      })
    : threadMembersQueryOptions(viewerId, thread);
};
