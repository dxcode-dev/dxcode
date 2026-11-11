import type { ThreadId, UserId } from "@dx/domain";
import {
  hashKey,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  markThreadSeen,
  type ThreadListClientItem,
  type ThreadPage,
} from "../../shared/api/client.js";
import { spaceKeys } from "../spaces/space-cache-queries.js";
import { isOptimisticThread, wasCreatedHere } from "./thread-mutations.js";
import { invalidateThreadLists, threadKeys } from "./thread-queries.js";
import { expectSeenEcho } from "./thread-row-queries.js";

type Row = ThreadListClientItem;

/** Every Space's Threads tab list this client holds. */
const spaceThreadLists = (userId: UserId) => ({
  queryKey: spaceKeys.all(userId),
  predicate: ({ queryKey }: { readonly queryKey: ReadonlyArray<unknown> }) =>
    queryKey[4] === "threads" && queryKey.length === 5,
});

const cachedRow = (client: QueryClient, userId: UserId, threadId: ThreadId) => {
  const rows = [
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
    ...client
      .getQueriesData<ReadonlyArray<Row>>(spaceThreadLists(userId))
      .flatMap(([, rows]) => rows ?? []),
  ].filter(({ id }) => id === threadId);
  // A list read before the Thread finished may still hold it read.
  return rows.find(({ unread }) => unread) ?? rows[0];
};

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
 * Opening a Thread is seeing it. The sidebar and a Space's Threads tab drop
 * its unread dot, and its parent's, at once; the server records it, and a failure refetches the
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
    client.setQueriesData<ReadonlyArray<Row>>(
      spaceThreadLists(userId),
      (rows) => (rows === undefined ? rows : change(rows)),
    );
  }
  // A listed row that is not unread has nothing to record, nor has one this
  // client created. Any other might be: holding its detail says nothing,
  // since a Space's tab shows a thread and a hover preloads one unseen.
  if (row === undefined ? wasCreatedHere(threadId) : row.unread !== true)
    return;
  const mark = () => {
    expectSeenEcho(threadId);
    void markThreadSeen(threadId).catch(() =>
      invalidateThreadLists(client, userId),
    );
  };
  if (
    row !== undefined ||
    client.getQueryState(threadKeys.detail(userId, threadId))?.status ===
      "success"
  )
    return mark();
  // Known to no list yet, such as a URL loaded fresh: marked once the
  // Thread loads, so one that does not exist, or is hidden, is never sent.
  markWhenLoaded(client, userId, threadId, mark);
};

/** How long to wait for an opened Thread to load before giving up. */
const SEEN_WAIT_MS = 60_000;

const markWhenLoaded = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  mark: () => void,
) => {
  const hash = hashKey(threadKeys.detail(userId, threadId));
  const cache = client.getQueryCache();
  let unsubscribe = () => {};
  const timer = setTimeout(() => unsubscribe(), SEEN_WAIT_MS);
  unsubscribe = cache.subscribe(({ query }) => {
    if (query.queryHash !== hash) return;
    if (query.state.status === "success") {
      unsubscribe();
      clearTimeout(timer);
      mark();
    } else if (query.state.status === "error") {
      unsubscribe();
      clearTimeout(timer);
    }
  });
};
