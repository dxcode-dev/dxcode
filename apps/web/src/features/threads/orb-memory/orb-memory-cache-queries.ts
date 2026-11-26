import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * The Orb memory cache keys and their invalidation, apart from the queries:
 * the realtime client imports these on first load, the endpoints load with
 * the notice.
 */
export const orbMemoryKeys = {
  all: ["thread-orb-memory"] as const,
  thread: (threadId: ThreadId) => ["thread-orb-memory", threadId] as const,
};

export const invalidateOrbMemory = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries({ queryKey: orbMemoryKeys.thread(threadId) });

export const invalidateAllOrbMemory = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: orbMemoryKeys.all });
