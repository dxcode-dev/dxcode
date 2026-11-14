import {
  type ArtifactFolder,
  ArtifactFolderResponseSchema,
  type ArtifactLibraryFilter,
  type ArtifactLibraryItem,
  ArtifactLibraryItemResponseSchema,
  ArtifactLibraryResponseSchema,
  type ArtifactSharing,
  DeleteArtifactFolderResponseSchema,
  type ThreadArtifactKind,
} from "@dx/api";
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { noticeUnauthenticated } from "../../../shared/auth/session-ended.js";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { ArtifactApiError } from "../artifacts-api.js";
import { ARTIFACT_LIBRARY_KEY } from "../artifacts-queries.js";

/**
 * The Artifacts library's data: every artifact the person may open
 * (`/v1/artifacts`), one artifact's location for an `/artifacts/<id>` link,
 * creating a standalone artifact, and sharing it. Reading and saving the
 * artifact itself use the artifact queries with the item's scope
 * (`scopeOf`): its Thread, or the standalone artifact itself.
 */

const send = async <S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  schema: S,
  init: RequestInit = {},
): Promise<S["Type"]> => {
  const response = await sameOriginFetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
  });
  noticeUnauthenticated(response);
  const body = (await response.json().catch(() => undefined)) as
    | { data?: { code?: string; message?: string } }
    | undefined;
  if (!response.ok)
    throw new ArtifactApiError(
      response.status,
      body?.data?.code ?? "ARTIFACTS_UNAVAILABLE",
      body?.data?.message ?? "Artifacts are temporarily unavailable.",
    );
  return Schema.decodeUnknownPromise(schema)(body);
};

export const libraryKeys = {
  all: ARTIFACT_LIBRARY_KEY,
  lists: () => [...libraryKeys.all, "list"] as const,
  list: (filter: ArtifactLibraryFilter, query: string) =>
    [...libraryKeys.lists(), filter, query.trim()] as const,
  item: (artifactId: string) =>
    [...libraryKeys.all, "item", artifactId] as const,
};

/**
 * The artifacts the person may open in `filter`, whose titles hold `query`:
 * their pins first, then what they made, then the rest, newest save first;
 * and their folders.
 */
export const artifactLibraryOptions = (
  filter: ArtifactLibraryFilter = "all",
  query = "",
) =>
  queryOptions({
    queryKey: libraryKeys.list(filter, query),
    queryFn: async ({ signal }) => {
      const search = new URLSearchParams({ filter });
      if (query.trim() !== "") search.set("q", query.trim());
      return (
        await send(`/v1/artifacts?${search}`, ArtifactLibraryResponseSchema, {
          signal,
        })
      ).data;
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    // Someone may share an artifact with this person at any time.
    refetchInterval: 30_000,
  });

/** Where an artifact lives and what the person may do with it. */
/** An artifact was deleted: forget it, and list the library afresh. */
export const forgetLibraryArtifact = (
  queryClient: QueryClient,
  artifactId: string,
) => {
  queryClient.removeQueries({ queryKey: libraryKeys.item(artifactId) });
  void queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
};

export const artifactLibraryItemOptions = (artifactId: string) =>
  queryOptions({
    queryKey: libraryKeys.item(artifactId),
    queryFn: async ({ signal }) =>
      (
        await send(
          `/v1/artifacts/${encodeURIComponent(artifactId)}`,
          ArtifactLibraryItemResponseSchema,
          { signal },
        )
      ).data.item,
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ArtifactApiError && error.status === 404) && count < 2,
  });

const accept = (client: QueryClient, item: ArtifactLibraryItem) => {
  client.setQueryData(libraryKeys.item(item.id), item);
  void client.invalidateQueries({ queryKey: libraryKeys.lists() });
};

export const createStandaloneArtifactMutation = (
  client: QueryClient,
  onCreated: (item: ArtifactLibraryItem) => void,
) =>
  mutationOptions({
    mutationFn: async (input: {
      readonly title: string;
      readonly kind: ThreadArtifactKind;
    }) =>
      (
        await send("/v1/artifacts", ArtifactLibraryItemResponseSchema, {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).data.item,
    onSuccess: (item) => {
      accept(client, item);
      onCreated(item);
    },
  });

export const shareArtifactMutation = (
  client: QueryClient,
  artifactId: string,
) =>
  mutationOptions({
    mutationFn: async (sharing: ArtifactSharing) =>
      (
        await send(
          `/v1/artifacts/${encodeURIComponent(artifactId)}/sharing`,
          ArtifactLibraryItemResponseSchema,
          { method: "PUT", body: JSON.stringify({ sharing }) },
        )
      ).data.item,
    onSuccess: (item) => accept(client, item),
  });

/** Pins or unpins an artifact, for the person alone. */
export const pinArtifactMutation = (client: QueryClient, artifactId: string) =>
  mutationOptions({
    mutationFn: async (pinned: boolean) =>
      (
        await send(
          `/v1/artifacts/${encodeURIComponent(artifactId)}/pin`,
          ArtifactLibraryItemResponseSchema,
          { method: pinned ? "PUT" : "DELETE" },
        )
      ).data.item,
    onSuccess: (item) => accept(client, item),
  });

/** Files an artifact in one of the person's folders, or takes it out. */
export const fileArtifactMutation = (client: QueryClient, artifactId: string) =>
  mutationOptions({
    mutationFn: async (folderId: string | null) =>
      (
        await send(
          `/v1/artifacts/${encodeURIComponent(artifactId)}/folder`,
          ArtifactLibraryItemResponseSchema,
          { method: "PUT", body: JSON.stringify({ folderId }) },
        )
      ).data.item,
    onSuccess: (item) => accept(client, item),
  });

/** Makes a folder, or renames one when `folderId` is given. */
export const saveFolderMutation = (
  client: QueryClient,
  onSaved?: (folder: ArtifactFolder) => void,
) =>
  mutationOptions({
    mutationFn: async (input: {
      readonly folderId?: string;
      readonly name: string;
    }) =>
      (
        await send(
          input.folderId === undefined
            ? "/v1/artifacts/folders"
            : `/v1/artifacts/folders/${encodeURIComponent(input.folderId)}`,
          ArtifactFolderResponseSchema,
          {
            method: input.folderId === undefined ? "POST" : "PATCH",
            body: JSON.stringify({ name: input.name.trim() }),
          },
        )
      ).data.folder,
    onSuccess: (folder) => {
      void client.invalidateQueries({ queryKey: libraryKeys.lists() });
      onSaved?.(folder);
    },
  });

/** Deletes a folder; its artifacts go back to the top of the library. */
export const deleteFolderMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (folderId: string) =>
      send(
        `/v1/artifacts/folders/${encodeURIComponent(folderId)}`,
        DeleteArtifactFolderResponseSchema,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: libraryKeys.lists() }),
  });
