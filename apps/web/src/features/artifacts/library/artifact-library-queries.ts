import {
  type ArtifactFolder,
  type ArtifactLibraryFilter,
  type ArtifactLibraryItem,
  type ArtifactSharing,
  CreateArtifactFolderEndpoint,
  CreateStandaloneArtifactEndpoint,
  DeleteArtifactFolderEndpoint,
  GetArtifactLibraryItemEndpoint,
  ListArtifactLibraryEndpoint,
  MoveArtifactToFolderEndpoint,
  PinArtifactEndpoint,
  RenameArtifactFolderEndpoint,
  type ThreadArtifactKind,
  UnpinArtifactEndpoint,
  UpdateArtifactSharingEndpoint,
} from "@dx/api";
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  ArtifactApiError,
  sendArtifactRequest,
} from "../artifacts-api-queries.js";
import { ARTIFACT_LIBRARY_KEY } from "../artifacts-queries.js";

/**
 * The Artifacts library's data: every artifact the person may open, one artifact's location for an `/artifacts/<id>` link,
 * creating a standalone artifact, and sharing it. Reading and saving the
 * artifact itself use the artifact queries with the item's scope
 * (`scopeOf`): its Thread, or the standalone artifact itself.
 */

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
    queryFn: async ({ signal }) =>
      (
        await sendArtifactRequest(
          ListArtifactLibraryEndpoint,
          {
            query: {
              filter,
              ...(query.trim() === "" ? {} : { q: query.trim() }),
            },
          },
          { signal },
        )
      ).data,
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
        await sendArtifactRequest(
          GetArtifactLibraryItemEndpoint,
          { params: { artifactId } },
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
        await sendArtifactRequest(CreateStandaloneArtifactEndpoint, {
          body: input,
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
        await sendArtifactRequest(UpdateArtifactSharingEndpoint, {
          params: { artifactId },
          body: { sharing },
        })
      ).data.item,
    onSuccess: (item) => accept(client, item),
  });

/** Pins or unpins an artifact, for the person alone. */
export const pinArtifactMutation = (client: QueryClient, artifactId: string) =>
  mutationOptions({
    mutationFn: async (pinned: boolean) =>
      (
        await sendArtifactRequest(
          pinned ? PinArtifactEndpoint : UnpinArtifactEndpoint,
          { params: { artifactId } },
        )
      ).data.item,
    onSuccess: (item) => accept(client, item),
  });

/** Files an artifact in one of the person's folders, or takes it out. */
export const fileArtifactMutation = (client: QueryClient, artifactId: string) =>
  mutationOptions({
    mutationFn: async (folderId: string | null) =>
      (
        await sendArtifactRequest(MoveArtifactToFolderEndpoint, {
          params: { artifactId },
          body: { folderId },
        })
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
      (input.folderId === undefined
        ? await sendArtifactRequest(CreateArtifactFolderEndpoint, {
            body: { name: input.name.trim() },
          })
        : await sendArtifactRequest(RenameArtifactFolderEndpoint, {
            params: { folderId: input.folderId },
            body: { name: input.name.trim() },
          })
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
      sendArtifactRequest(DeleteArtifactFolderEndpoint, {
        params: { folderId },
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: libraryKeys.lists() }),
  });
