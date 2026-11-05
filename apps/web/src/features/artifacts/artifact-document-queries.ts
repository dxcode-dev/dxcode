import type { ThreadId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ArtifactApiError,
  type ArtifactDocument,
  artifactsApi,
  deleteArtifact,
  notifyArtifactAgent,
} from "./artifacts-api.js";
import { artifactKeys, invalidateArtifacts } from "./artifacts-queries.js";

export const artifactListOptions = (threadId: ThreadId, active = true) =>
  queryOptions({
    queryKey: artifactKeys.list(threadId),
    queryFn: ({ signal }) => artifactsApi.list(threadId, signal),
    enabled: active,
    staleTime: 10_000,
    retry: 2,
  });

export const artifactOptions = (
  threadId: ThreadId,
  artifactId: string,
  active = true,
) =>
  queryOptions({
    queryKey: artifactKeys.detail(threadId, artifactId),
    queryFn: ({ signal }) => artifactsApi.get(threadId, artifactId, signal),
    enabled: active,
    staleTime: 10_000,
    retry: 2,
    refetchOnWindowFocus: "always",
  });

/** A save's answer is the artifact's newest revision: show it at once. */
export const acceptSavedArtifact = (
  client: QueryClient,
  threadId: ThreadId,
  saved: ArtifactDocument,
) => {
  const key = artifactKeys.detail(threadId, saved.artifact.id);
  const shown = client.getQueryData<ArtifactDocument>(key);
  if (shown === undefined || shown.artifact.revision <= saved.artifact.revision)
    client.setQueryData(key, saved);
  void client.invalidateQueries(
    { queryKey: artifactKeys.list(threadId) },
    { cancelRefetch: false },
  );
};

export const createArtifactMutation = (
  client: QueryClient,
  threadId: ThreadId,
  onCreated: (created: ArtifactDocument) => void,
) =>
  mutationOptions({
    mutationFn: (input: { readonly title: string; readonly folder?: string }) =>
      artifactsApi.create(threadId, { ...input, markdown: "" }),
    onSuccess: (created) => {
      acceptSavedArtifact(client, threadId, created);
      onCreated(created);
    },
  });

/** The artifact is gone: deleted, or never this Thread's. */
export const isMissingArtifact = (error: unknown) =>
  error instanceof ArtifactApiError && error.status === 404;

/** Deletes an artifact, then refreshes the Thread's artifacts. */
export const deleteArtifactMutation = (
  client: QueryClient,
  threadId: ThreadId,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: () => deleteArtifact(threadId, artifactId),
    onSettled: () => invalidateArtifacts(client, threadId),
  });

/** Notify agent: one wake for the artifact's Thread, with what changed. */
export const notifyArtifactAgentMutation = (
  threadId: ThreadId,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: () => notifyArtifactAgent(threadId, artifactId),
  });
