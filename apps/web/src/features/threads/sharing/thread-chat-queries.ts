import type { ThreadId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { getThreadMembers } from "../../../shared/api/client.js";
import { threadKeys } from "../thread-queries.js";

/** Members of the workspace a shared Thread is shared with. */
export const threadMembersQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadKeys.members(userId, threadId),
    queryFn: ({ signal }) => getThreadMembers(threadId, signal),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
