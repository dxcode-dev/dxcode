import type { CreateThreadArtifactCommentRequest } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  createArtifactComment,
  listArtifactComments,
  resolveArtifactComment,
} from "./artifacts-api.js";
import { artifactKeys } from "./artifacts-queries.js";

export const artifactCommentsOptions = (
  threadId: ThreadId,
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
const refresh = (client: QueryClient, threadId: ThreadId, artifactId: string) =>
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
  threadId: ThreadId,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: (input: CreateThreadArtifactCommentRequest) =>
      createArtifactComment(threadId, artifactId, input),
    onSuccess: () => refresh(client, threadId, artifactId),
  });

export const resolveArtifactCommentMutation = (
  client: QueryClient,
  threadId: ThreadId,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: (commentId: string) =>
      resolveArtifactComment(threadId, artifactId, commentId),
    onSuccess: () => refresh(client, threadId, artifactId),
  });
