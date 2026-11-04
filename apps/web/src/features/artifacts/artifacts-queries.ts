import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Artifact query keys and their invalidation, apart from the requests
 * (artifact-document-queries.ts), so the realtime client can refresh
 * artifacts without loading the artifacts client.
 */
export const artifactKeys = {
  all: (threadId: ThreadId) => ["thread-artifacts", threadId] as const,
  list: (threadId: ThreadId) =>
    [...artifactKeys.all(threadId), "list"] as const,
  detail: (threadId: ThreadId, artifactId: string) =>
    [...artifactKeys.all(threadId), "detail", artifactId] as const,
  comments: (threadId: ThreadId, artifactId: string) =>
    [...artifactKeys.all(threadId), "comments", artifactId] as const,
};

/** `artifacts.invalidated`: an artifact was created, saved, or deleted. */
export const invalidateArtifacts = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries(
    { queryKey: artifactKeys.all(threadId) },
    { cancelRefetch: false },
  );

export const invalidateAllArtifacts = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ["thread-artifacts"] });
