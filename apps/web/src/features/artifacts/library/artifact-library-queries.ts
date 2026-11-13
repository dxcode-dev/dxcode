import {
  type ArtifactLibraryFilter,
  type ArtifactLibraryItem,
  ArtifactLibraryItemResponseSchema,
  ArtifactLibraryResponseSchema,
  type ArtifactSharing,
  type ThreadArtifactKind,
} from "@dx/api";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { noticeUnauthenticated } from "../../../shared/auth/session-ended.js";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { ArtifactApiError } from "../artifacts-api.js";

/**
 * The Artifacts library's data: every artifact the person may open
 * (`/v1/artifacts`), one artifact's location for an `/artifacts/<id>` link,
 * creating a standalone artifact, and sharing it. Reading and saving the
 * artifact itself use the Thread artifact queries with the item's
 * `threadId`.
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
  all: ["artifact-library"] as const,
  list: () => [...libraryKeys.all, "list"] as const,
  item: (artifactId: string) =>
    [...libraryKeys.all, "item", artifactId] as const,
};

/**
 * Every artifact the person may open, newest save first. Search and
 * filters run on this list as the person types, so one request serves
 * them all.
 */
export const artifactLibraryOptions = () =>
  queryOptions({
    queryKey: libraryKeys.list(),
    queryFn: async ({ signal }) =>
      (await send("/v1/artifacts", ArtifactLibraryResponseSchema, { signal }))
        .data.items,
    staleTime: 10_000,
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
  void queryClient.invalidateQueries({ queryKey: libraryKeys.list() });
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
  void client.invalidateQueries({ queryKey: libraryKeys.list() });
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

/** What the library's filter chips select. */
export const matchesFilter = (
  item: ArtifactLibraryItem,
  filter: ArtifactLibraryFilter,
  userId: string,
) => {
  switch (filter) {
    case "all":
      return true;
    case "mine":
      return item.source.kind === "standalone" && item.owner.userId === userId;
    case "shared":
      return item.owner.userId !== userId;
    case "threads":
      return item.source.kind !== "standalone";
  }
};

/** Whether `item`'s title holds every word of `query`, case-insensitively. */
export const matchesQuery = (item: ArtifactLibraryItem, query: string) => {
  const title = item.title.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => title.includes(word));
};
