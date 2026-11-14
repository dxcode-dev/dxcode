import type { QueryClient } from "@tanstack/react-query";
import type { ArtifactScope } from "./artifact-scope.js";

/**
 * Artifact query keys and their invalidation, apart from the requests
 * (artifact-document-queries.ts), so the realtime client can refresh
 * artifacts without loading the artifacts client.
 */
export const artifactKeys = {
  all: (threadId: ArtifactScope) => ["thread-artifacts", threadId] as const,
  list: (threadId: ArtifactScope) =>
    [...artifactKeys.all(threadId), "list"] as const,
  detail: (threadId: ArtifactScope, artifactId: string) =>
    [...artifactKeys.all(threadId), "detail", artifactId] as const,
  comments: (threadId: ArtifactScope, artifactId: string) =>
    [...artifactKeys.all(threadId), "comments", artifactId] as const,
};

/** `artifacts.invalidated`: an artifact was created, saved, or deleted. */
export const invalidateArtifacts = (
  client: QueryClient,
  threadId: ArtifactScope,
) =>
  client.invalidateQueries(
    { queryKey: artifactKeys.all(threadId) },
    { cancelRefetch: false },
  );

export const invalidateAllArtifacts = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ["thread-artifacts"] });

/** The Artifacts library's root key (library/artifact-library-queries.ts). */
export const ARTIFACT_LIBRARY_KEY = ["artifact-library"] as const;

/** `artifact.invalidated`: a standalone artifact changed or was shared. */
export const invalidateArtifactLibrary = (client: QueryClient) =>
  client.invalidateQueries(
    { queryKey: ARTIFACT_LIBRARY_KEY },
    { cancelRefetch: false },
  );
