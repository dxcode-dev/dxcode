import type { ThreadId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { getThreadTree } from "../../../shared/api/client.js";
import { threadKeys } from "../thread-queries.js";

/** How often an open tree page refreshes its Threads' status. */
const TREE_REFRESH_MS = 15_000;

export const threadTreeQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadKeys.tree(userId, threadId),
    queryFn: ({ signal }) => getThreadTree(threadId, signal),
    staleTime: 10_000,
    refetchInterval: TREE_REFRESH_MS,
  });
