import {
  GetThreadOrbMemoryEndpoint,
  type OrbProcessId,
  StopThreadOrbProcessEndpoint,
  type ThreadOrbMemoryData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";
import {
  invalidateOrbMemory,
  orbMemoryKeys,
} from "./orb-memory-cache-queries.js";

/** Live while the card has something to show; a slow fallback otherwise. */
const refetchInterval = (data: ThreadOrbMemoryData | undefined) =>
  data?.processes.some((process) => process.state === "stopping")
    ? 1_000
    : data?.memory?.pressure === true
      ? 2_000
      : 60_000;

/**
 * The Thread's Orb memory. Reading never wakes a paused workspace. A
 * `memory.invalidated` hint refetches it the moment pressure starts.
 */
export const threadOrbMemoryQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    queryKey: orbMemoryKeys.thread(threadId),
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          GetThreadOrbMemoryEndpoint,
          { params: { threadId } },
          { signal },
        )
      ).data,
    staleTime: 1_000,
    refetchInterval: (query) => refetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });

/** Stops one listed process; the card then reads its state from the Orb. */
export const useStopOrbProcess = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...orbMemoryKeys.thread(threadId), "stop"],
    mutationFn: async (process: OrbProcessId) =>
      (
        await dxClient.call(StopThreadOrbProcessEndpoint, {
          params: { threadId, processId: process },
        })
      ).data,
    onSettled: () => invalidateOrbMemory(client, threadId),
  });
};

/** Why a stop was refused, in words for its row; undefined without one. */
export const stopRefusal = (error: unknown) => {
  if (error === null || error === undefined) return undefined;
  const code = error instanceof ApiError ? error.code : undefined;
  return code === "ORB_PROCESS_PROTECTED"
    ? "dx needs this one"
    : code === "ORB_PROCESS_NOT_FOUND"
      ? "It already exited"
      : "Couldn’t stop it";
};
