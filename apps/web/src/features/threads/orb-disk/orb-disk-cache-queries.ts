import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * The Orb disk cache keys and their invalidation, apart from the queries:
 * the realtime client imports these on first load, the endpoints load with
 * the notice.
 */
export const orbDiskKeys = {
  all: ["thread-orb-disk"] as const,
  thread: (threadId: ThreadId) => ["thread-orb-disk", threadId] as const,
  folders: (threadId: ThreadId) =>
    ["thread-orb-disk", threadId, "folders"] as const,
};

export const invalidateOrbDisk = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries({ queryKey: orbDiskKeys.thread(threadId) });

export const invalidateAllOrbDisk = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: orbDiskKeys.all });
