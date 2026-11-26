import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  ThreadListClientItem,
  ThreadPage,
} from "../../shared/api/client.js";
import { millis } from "../threads/thread-list-order-queries.js";
import { threadKeys } from "../threads/thread-queries.js";

/** A Thread whose finished turn the person has not seen. */
export interface ThreadAttention {
  readonly id: string;
  readonly title: string;
  readonly failed: boolean;
  /** Changes with each new finished turn, so a second one notifies again. */
  readonly activity: string;
}

const rowsOf = (data: unknown): ReadonlyArray<ThreadListClientItem> => {
  const pages = (data as InfiniteData<ThreadPage> | undefined)?.pages;
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => [...page.items, ...(page.children ?? [])]);
};

/**
 * Every unread Thread in the loaded Thread lists, the same `unread` the
 * sidebar shows: the agent finished a turn after the person last opened it.
 * Archived Threads do not count.
 */
export const threadsNeedingAttention = (
  client: QueryClient,
): ReadonlyMap<string, ThreadAttention> => {
  const found = new Map<string, ThreadAttention>();
  for (const query of client.getQueryCache().getAll()) {
    if (!threadKeys.isList(query.queryKey)) continue;
    for (const row of rowsOf(query.state.data)) {
      if (row.unread !== true || row.lifecycleState === "archived") continue;
      found.set(row.id, {
        id: row.id,
        title: row.title,
        failed: row.turnFailed === true,
        activity: String(millis(row.lastActivityAt)),
      });
    }
  }
  return found;
};

/**
 * What changed between two snapshots: Threads that became unread, or that
 * finished another turn while unread. The first snapshot after launch is the
 * baseline, so opening the app does not replay old turns.
 */
export const newlyNeedingAttention = (
  before: ReadonlyMap<string, ThreadAttention> | undefined,
  after: ReadonlyMap<string, ThreadAttention>,
): ReadonlyArray<ThreadAttention> => {
  if (before === undefined) return [];
  return [...after.values()].filter(
    (thread) => before.get(thread.id)?.activity !== thread.activity,
  );
};

/** A Thread for the shell's menu bar list. */
export interface RecentThread {
  readonly id: string;
  readonly title: string;
  readonly unread: boolean;
}

/** The most recently active Threads in the loaded lists, newest first. */
export const recentThreads = (
  client: QueryClient,
  limit: number,
): ReadonlyArray<RecentThread> => {
  const rows = new Map<string, ThreadListClientItem>();
  for (const query of client.getQueryCache().getAll()) {
    if (!threadKeys.isList(query.queryKey)) continue;
    for (const row of rowsOf(query.state.data))
      if (row.lifecycleState !== "archived") rows.set(row.id, row);
  }
  return [...rows.values()]
    .sort(
      (a, b) =>
        (millis(b.lastActivityAt) ?? 0) - (millis(a.lastActivityAt) ?? 0),
    )
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      title: row.title,
      unread: row.unread === true,
    }));
};
