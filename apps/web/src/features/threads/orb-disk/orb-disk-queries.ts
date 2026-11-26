import {
  DeleteThreadOrbFolderEndpoint,
  GetThreadOrbDiskEndpoint,
  type ThreadOrbDiskData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";
import { invalidateOrbDisk, orbDiskKeys } from "./orb-disk-cache-queries.js";

const diskRequest = (
  threadId: ThreadId,
  folders: boolean,
  signal: AbortSignal,
) =>
  dxClient.call(
    GetThreadOrbDiskEndpoint,
    { params: { threadId }, query: folders ? { folders: "1" } : {} },
    { signal },
  );

/** Live while the card shows pressure; a slow fallback otherwise. */
const refetchInterval = (data: ThreadOrbDiskData | undefined) =>
  data?.disk?.pressure === true ? 2_000 : 60_000;

/**
 * The Thread's Orb disk usage, from the daemon's last heartbeat. Reading
 * never wakes a paused workspace. A `disk.invalidated` hint refetches it
 * the moment the disk starts filling up.
 */
export const threadOrbDiskQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    queryKey: orbDiskKeys.thread(threadId),
    queryFn: async ({ signal }) =>
      (await diskRequest(threadId, false, signal)).data,
    staleTime: 1_000,
    refetchInterval: (query) => refetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });

/**
 * The largest folders, measured in the Orb (a few seconds at most). Only
 * the open disk notice asks for them.
 */
export const threadOrbFoldersQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    queryKey: orbDiskKeys.folders(threadId),
    queryFn: async ({ signal }) =>
      (await diskRequest(threadId, true, signal)).data,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

/** Deletes one listed rebuildable folder; the list and usage then refresh. */
export const useDeleteOrbFolder = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...orbDiskKeys.thread(threadId), "delete"],
    mutationFn: async (path: string) =>
      (
        await dxClient.call(DeleteThreadOrbFolderEndpoint, {
          params: { threadId },
          body: { path },
        })
      ).data,
    onSettled: () => invalidateOrbDisk(client, threadId),
  });
};

/** Why a delete was refused, in words for its row; undefined without one. */
export const deleteRefusal = (error: unknown) => {
  if (error === null || error === undefined) return undefined;
  const code = error instanceof ApiError ? error.code : undefined;
  return code === "ORB_FOLDER_PROTECTED"
    ? "dx keeps this one"
    : code === "ORB_FOLDER_NOT_FOUND"
      ? "Already gone"
      : "Couldn’t delete it";
};
