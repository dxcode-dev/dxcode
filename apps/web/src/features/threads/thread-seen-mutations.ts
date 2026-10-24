import type { ThreadId, UserId } from "@dx/domain";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  markThreadSeen,
  type ThreadListClientItem,
  type ThreadPage,
} from "../../shared/api/client.js";
import { isOptimisticThread } from "./thread-mutations.js";
import { invalidateThreadLists, threadKeys } from "./thread-queries.js";

type Row = ThreadListClientItem;

const cachedRow = (client: QueryClient, userId: UserId, threadId: ThreadId) =>
  [
    ...client
      .getQueriesData<InfiniteData<ThreadPage>>({
        queryKey: threadKeys.lists(userId),
      })
      .flatMap(([, data]) =>
        (data?.pages ?? []).flatMap((page) => [
          ...page.items,
          ...(page.children ?? []),
        ]),
      ),
    ...(client.getQueryData<ReadonlyArray<Row>>(threadKeys.shared(userId)) ??
      []),
  ].find(({ id }) => id === threadId);

/**
 * The row as the server lists it once the Thread is seen: not unread, and
 * its parent counts one unread child fewer.
 */
const seenRow = (row: Row, threadId: ThreadId, parentId?: ThreadId): Row => {
  if (row.id === threadId && row.unread !== undefined) {
    const { unread: _unread, ...rest } = row;
    return rest;
  }
  if (row.id === parentId && row.childActivity !== undefined)
    return {
      ...row,
      childActivity: {
        ...row.childActivity,
        unread: Math.max(0, row.childActivity.unread - 1),
      },
    };
  return row;
};

/**
 * Opening a Thread is seeing it. The sidebar drops its unread dot, and its
 * parent's, at once; the server records it, and a failure refetches the
 * lists so they show what it holds.
 */
export const openThreadSeen = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const row = cachedRow(client, userId, threadId);
  // A Thread still being created has finished nothing; having it open as
  // its first turn settles marks it seen.
  if (row !== undefined && isOptimisticThread(row)) return;
  if (row?.unread === true) {
    const parentId = row.parentThreadId;
    const change = (rows: ReadonlyArray<Row>) =>
      rows.map((item) => seenRow(item, threadId, parentId));
    client.setQueriesData<InfiniteData<ThreadPage>>(
      { queryKey: threadKeys.lists(userId) },
      (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: change(page.items),
                ...(page.children === undefined
                  ? {}
                  : { children: change(page.children) }),
              })),
            },
    );
    client.setQueryData<ReadonlyArray<Row>>(
      threadKeys.shared(userId),
      (rows) => (rows === undefined ? rows : change(rows)),
    );
  }
  // A listed row that is not unread has nothing to record. One no list
  // holds might be, unless it is one this client just created or showed,
  // whose detail it already holds.
  if (row !== undefined && row.unread !== true) return;
  if (
    row === undefined &&
    client.getQueryData(threadKeys.detail(userId, threadId)) !== undefined
  )
    return;
  void markThreadSeen(threadId).catch(() =>
    invalidateThreadLists(client, userId),
  );
};
