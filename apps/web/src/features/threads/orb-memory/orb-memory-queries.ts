import {
  GetThreadOrbMemoryResponseSchema,
  type OrbProcessId,
  StopThreadOrbProcessResponseSchema,
  type ThreadOrbMemoryData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, request } from "../../../shared/api/client.js";

export const orbMemoryKeys = {
  all: ["thread-orb-memory"] as const,
  thread: (threadId: ThreadId) => ["thread-orb-memory", threadId] as const,
};

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
        await request(
          `/v1/threads/${encodeURIComponent(threadId)}/memory`,
          GetThreadOrbMemoryResponseSchema,
          { signal },
        )
      ).data,
    staleTime: 1_000,
    refetchInterval: (query) => refetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });

export const invalidateOrbMemory = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries({ queryKey: orbMemoryKeys.thread(threadId) });

export const invalidateAllOrbMemory = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: orbMemoryKeys.all });

/** Stops one listed process; the card then reads its state from the Orb. */
export const useStopOrbProcess = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...orbMemoryKeys.thread(threadId), "stop"],
    mutationFn: async (process: OrbProcessId) =>
      (
        await request(
          `/v1/threads/${encodeURIComponent(threadId)}/memory/processes/${encodeURIComponent(process)}/stop`,
          StopThreadOrbProcessResponseSchema,
          { method: "POST" },
        )
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
