import type { ThreadId, UserId } from "@dx/domain";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  getThreadListItem,
  type ThreadListClientItem,
  type ThreadPage,
} from "../../shared/api/client.js";
import { shareEqualData } from "../../shared/query/structural-sharing.js";
import { isOptimisticThread } from "./thread-mutations.js";
import {
  invalidateThreadLists,
  THREAD_FRESHNESS_SLO_MS,
  threadKeys,
} from "./thread-queries.js";

type Row = ThreadListClientItem;
type ListData = InfiniteData<ThreadPage, unknown>;

/** Hints for one Thread within this window share one row read. */
export const THREAD_ROW_COALESCE_MS = 250;

const millis = (time: DateTime.Utc | undefined) =>
  time === undefined ? undefined : DateTime.toEpochMillis(time);

/**
 * Core's list order: pinned Threads first, newest pin first, then newest
 * activity, then the higher ID. Children and shared Threads are never pinned.
 */
const listOrder = (a: Row, b: Row) => {
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

/**
 * Changes that move a row between lists, under another parent, or change
 * what its children show: the lists are refetched instead of patched.
 */
const isStructural = (cached: Row, row: Row) =>
  cached.lifecycleState !== row.lifecycleState ||
  millis(cached.pinnedAt) !== millis(row.pinnedAt) ||
  cached.parentThreadId !== row.parentThreadId ||
  cached.color !== row.color;

/**
 * Replaces the Thread's row and moves it to its place by list order, keeping
 * every other row where it was. Returns `rows` itself when nothing changed.
 */
const placeRow = <Rows extends ReadonlyArray<Row> | undefined>(
  rows: Rows,
  row: Row,
): Rows => {
  if (rows === undefined) return rows;
  const index = rows.findIndex(({ id }) => id === row.id);
  if (index === -1) return rows;
  const cached = rows[index] as Row;
  const next = shareEqualData(cached, row);
  if (next === cached) return rows;
  const others = rows.filter((_, position) => position !== index);
  const at = others.findIndex((other) => listOrder(next, other) < 0);
  const position = at === -1 ? others.length : at;
  return [
    ...others.slice(0, position),
    next,
    ...others.slice(position),
  ] as unknown as Rows;
};

const withoutChildCount = ({ childCount: _count, ...row }: Row): Row => row;

const listRows = (data: ListData | undefined, threadId: ThreadId) =>
  data?.pages.flatMap((page) =>
    [...page.items, ...(page.children ?? [])].filter(
      ({ id }) => id === threadId,
    ),
  ) ?? [];

interface ListFilters {
  readonly projectId: string | null;
  readonly lifecycleState: string | null;
  readonly tree: string | null;
}

/**
 * The list's filters admit the row, and its loaded pages reach the row's
 * place: the list should show the row, so a list without it is stale.
 */
const belongsInLoadedList = (
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

/** Only a roots list's own items show a child count. */
const isRootsList = (queryKey: readonly unknown[]) =>
  (queryKey[3] as { readonly tree?: unknown } | undefined)?.tree === "roots";

/** Each page's rows in list order, page after page. */
const pagesInOrder = (data: ListData) =>
  data.pages.every((page, index) => {
    const next = data.pages[index + 1]?.items[0];
    const last = page.items.at(-1);
    return (
      next === undefined || last === undefined || listOrder(last, next) <= 0
    );
  });

/**
 * A patch keeps a list's fetch time but restarts its refetch-interval timer,
 * so while hints keep arriving the list would never poll. A list last
 * fetched a poll interval ago is refetched with the patch.
 */
const isDue = (fetchedAt: number) =>
  Date.now() - fetchedAt >= THREAD_FRESHNESS_SLO_MS;

interface PendingRow {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  /** A `thread.invalidated` hint: refetch detail; refetch lists when no list holds the row. */
  thread: boolean;
  /** A `changes.invalidated` hint: patch lists whose totals may be stale. */
  changes: boolean;
  summaryChanged: boolean;
}

/**
 * Keeps cached Thread list rows current from realtime hints by reading one
 * Thread's row and patching it into every cached list that holds it.
 */
export class ThreadListRows {
  readonly #client: QueryClient;
  readonly #userId: UserId;
  readonly #fetchRow: (threadId: ThreadId) => Promise<Row>;
  readonly #pending = new Map<ThreadId, PendingRow>();
  /** Bumped by `stop`, so a read that outlives it patches nothing. */
  #generation = 0;

  constructor(
    client: QueryClient,
    userId: UserId,
    fetchRow: (threadId: ThreadId) => Promise<Row> = getThreadListItem,
  ) {
    this.#client = client;
    this.#userId = userId;
    this.#fetchRow = fetchRow;
  }

  /** The Thread changed: its row, detail, or both. */
  threadChanged(threadId: ThreadId) {
    this.#schedule(threadId, (pending) => {
      pending.thread = true;
    });
  }

  /**
   * The Thread's Changes moved. Lists holding it are patched when its totals
   * moved, or when they hold it without totals because they were loaded
   * while its Changes were stale or not yet captured. Shared lists carry no
   * totals.
   */
  changesChanged(threadId: ThreadId, summaryChanged: boolean) {
    this.#schedule(threadId, (pending) => {
      pending.changes = true;
      pending.summaryChanged ||= summaryChanged;
    });
  }

  stop() {
    this.#generation += 1;
    for (const pending of this.#pending.values())
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pending.clear();
  }

  #schedule(threadId: ThreadId, change: (pending: PendingRow) => void) {
    const pending = this.#pending.get(threadId) ?? {
      running: false,
      thread: false,
      changes: false,
      summaryChanged: false,
    };
    change(pending);
    this.#pending.set(threadId, pending);
    if (pending.timer === undefined && !pending.running)
      pending.timer = setTimeout(
        () => void this.#run(threadId, pending),
        THREAD_ROW_COALESCE_MS,
      );
  }

  async #run(threadId: ThreadId, pending: PendingRow) {
    pending.timer = undefined;
    const { thread, changes, summaryChanged } = pending;
    pending.thread = false;
    pending.changes = false;
    pending.summaryChanged = false;
    pending.running = true;
    await this.#refresh(threadId, { thread, changes, summaryChanged }).catch(
      () => this.#refetchLists(),
    );
    pending.running = false;
    // Hints that arrived during the read get a read of their own.
    if (this.#pending.get(threadId) !== pending) return;
    if (pending.thread || pending.changes)
      pending.timer = setTimeout(
        () => void this.#run(threadId, pending),
        THREAD_ROW_COALESCE_MS,
      );
    else this.#pending.delete(threadId);
  }

  #refetchLists() {
    return invalidateThreadLists(this.#client, this.#userId, {
      cancelRefetch: false,
    });
  }

  async #refresh(
    threadId: ThreadId,
    hint: Pick<PendingRow, "thread" | "changes" | "summaryChanged">,
  ) {
    const client = this.#client;
    const userId = this.#userId;
    const generation = this.#generation;
    // Restart a detail read already in flight: it may predate the change.
    if (hint.thread)
      void client.invalidateQueries({
        queryKey: threadKeys.detail(userId, threadId),
      });
    const lists = client
      .getQueryCache()
      .findAll({ queryKey: threadKeys.lists(userId) })
      .flatMap((query) => {
        const rows = listRows(
          query.state.data as ListData | undefined,
          threadId,
        );
        return rows.length === 0 ? [] : [{ queryKey: query.queryKey, rows }];
      });
    const shared = (
      client.getQueryData<ReadonlyArray<Row>>(threadKeys.shared(userId)) ?? []
    ).filter(({ id }) => id === threadId);
    const cached = [...lists.flatMap(({ rows }) => rows), ...shared];
    const refetchLists = () => this.#refetchLists();
    // A Thread no list holds yet, such as a new one.
    if (cached.length === 0) {
      if (hint.thread) await refetchLists();
      return;
    }
    if (
      !hint.thread &&
      !lists.some(({ rows }) =>
        rows.some((row) => hint.summaryChanged || row.changes === undefined),
      )
    )
      return;
    if (cached.some(isOptimisticThread)) return refetchLists();
    let row: Row;
    try {
      row = await this.#fetchRow(threadId);
    } catch {
      // Gone, no longer shared with this person, or unreachable.
      return refetchLists();
    }
    if (generation !== this.#generation) return;
    if (cached.some((cachedRow) => isStructural(cachedRow, row)))
      return refetchLists();

    const childRow = withoutChildCount(row);
    for (const { queryKey } of lists) {
      const itemRow = isRootsList(queryKey) ? row : childRow;
      const data = client.getQueryData<ListData>(queryKey);
      if (data === undefined) continue;
      let changed = false;
      const pages = data.pages.map((page) => {
        const items = placeRow(page.items, itemRow);
        const children = placeRow(page.children, childRow);
        if (items === page.items && children === page.children) return page;
        changed = true;
        return {
          ...page,
          items,
          ...(children === undefined ? {} : { children }),
        };
      });
      if (!changed) continue;
      const next = { ...data, pages };
      const fetchedAt = client.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
      client.setQueryData<ListData>(queryKey, next, { updatedAt: fetchedAt });
      // The row belongs on another loaded page, or the list is due its
      // minute refetch, which every patch postpones: refetch it.
      if (!pagesInOrder(next) || isDue(fetchedAt))
        void client.invalidateQueries(
          { queryKey, exact: true },
          { cancelRefetch: false },
        );
    }
    // A list that should now show the row but has not loaded it, such as the
    // sidebar after an older Thread's activity moved it to the top.
    if (hint.thread && lists.length > 0) {
      const holding = new Set(lists.map(({ queryKey }) => queryKey));
      for (const query of client
        .getQueryCache()
        .findAll({ queryKey: threadKeys.lists(userId) })) {
        const data = query.state.data as ListData | undefined;
        if (
          !holding.has(query.queryKey) &&
          data !== undefined &&
          belongsInLoadedList(query.queryKey, data, row)
        )
          void client.invalidateQueries(
            { queryKey: query.queryKey, exact: true },
            { cancelRefetch: false },
          );
      }
    }
    if (shared.length > 0) {
      const sharedKey = threadKeys.shared(userId);
      const fetchedAt = client.getQueryState(sharedKey)?.dataUpdatedAt ?? 0;
      client.setQueryData<ReadonlyArray<Row>>(
        sharedKey,
        (current) => current && placeRow(current, childRow),
        { updatedAt: fetchedAt },
      );
      if (isDue(fetchedAt))
        void client.invalidateQueries(
          { queryKey: sharedKey, exact: true },
          { cancelRefetch: false },
        );
    }
  }
}
