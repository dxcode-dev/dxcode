import {
  DeleteThreadOrbFolderResponseSchema,
  GetThreadOrbDiskResponseSchema,
  type ThreadOrbDiskData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, request } from "../../../shared/api/client.js";

export const orbDiskKeys = {
  all: ["thread-orb-disk"] as const,
  thread: (threadId: ThreadId) => ["thread-orb-disk", threadId] as const,
  folders: (threadId: ThreadId) =>
    ["thread-orb-disk", threadId, "folders"] as const,
};

const diskRequest = (
  threadId: ThreadId,
  folders: boolean,
  signal: AbortSignal,
) =>
  request(
    `/v1/threads/${encodeURIComponent(threadId)}/disk${folders ? "?folders=1" : ""}`,
    GetThreadOrbDiskResponseSchema,
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

export const invalidateOrbDisk = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries({ queryKey: orbDiskKeys.thread(threadId) });

export const invalidateAllOrbDisk = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: orbDiskKeys.all });

/** Deletes one listed rebuildable folder; the list and usage then refresh. */
export const useDeleteOrbFolder = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...orbDiskKeys.thread(threadId), "delete"],
    mutationFn: async (path: string) =>
      (
        await request(
          `/v1/threads/${encodeURIComponent(threadId)}/disk/folders/delete`,
          DeleteThreadOrbFolderResponseSchema,
          { method: "POST", body: JSON.stringify({ path }) },
        )
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
