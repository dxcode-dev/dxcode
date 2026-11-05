import type { InfiniteData } from "@tanstack/react-query";
import { DateTime } from "effect";
import type {
  ThreadListClientItem,
  ThreadPage,
} from "../../shared/api/client.js";

type Row = ThreadListClientItem;
type ListData = InfiniteData<ThreadPage, unknown>;

export const millis = (time: DateTime.Utc | undefined) =>
  time === undefined ? undefined : DateTime.toEpochMillis(time);

/**
 * Core's list order: pinned Threads first, newest pin first, then newest
 * activity, then the higher ID. Children and shared Threads are never pinned.
 */
export const listOrder = (a: Row, b: Row) => {
  const pinA = millis(a.pinnedAt);
  const pinB = millis(b.pinnedAt);
  if (pinA === undefined && pinB !== undefined) return 1;
  if (pinA !== undefined && pinB === undefined) return -1;
  if (pinA !== undefined && pinB !== undefined && pinA !== pinB)
    return pinB - pinA;
  const activity =
    DateTime.toEpochMillis(b.lastActivityAt) -
    DateTime.toEpochMillis(a.lastActivityAt);
  if (activity !== 0) return activity;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

interface ListFilters {
  readonly projectId: string | null;
  readonly lifecycleState: string | null;
  readonly tree: string | null;
}

/**
 * The list's filters admit the row, and its loaded pages reach the row's
 * place: the list should show the row, so a list without it is stale.
 */
export const belongsInLoadedList = (
  queryKey: readonly unknown[],
  data: ListData,
  row: Row,
) => {
  const filters = queryKey[3] as ListFilters | undefined;
  if (filters === undefined) return false;
  if (filters.projectId !== null && filters.projectId !== row.projectId)
    return false;
  if (
    filters.lifecycleState !== null &&
    filters.lifecycleState !== row.lifecycleState
  )
    return false;
  if (filters.tree === "roots" && row.parentThreadId !== undefined)
    return false;
  if (
    filters.tree !== null &&
    filters.tree !== "roots" &&
    filters.tree !== row.parentThreadId
  )
    return false;
  const lastPage = data.pages.at(-1);
  if (lastPage?.nextCursor === undefined) return true;
  const last = lastPage.items.at(-1);
  return last === undefined || listOrder(row, last) < 0;
};
