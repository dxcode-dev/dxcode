import type { ThreadData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { ThreadPage } from "../../shared/api/client.js";
import { listAdmits, listOrder } from "./thread-list-order-queries.js";

type Listed = ThreadPage["items"][number];
type ListData = InfiniteData<ThreadPage, unknown>;

/**
 * A change this page asked the server for, such as an archive, pin, or
 * rename, as the Thread will read once it applies.
 */
export interface RequestedChange {
  readonly threadId: ThreadId;
  /** The lifecycle the change leaves: which lists hold the Thread. */
  readonly lifecycleState?: "active" | "archived";
  /** The Thread, list row or detail, with the change applied. */
  readonly apply: <Thread extends ThreadData>(thread: Thread) => Thread;
  /** The row as the change leaves it, for a list that does not hold it. */
  readonly row?: Listed;
}

export interface RequestedChangeEntry extends RequestedChange {
  /** The read clock when the server answered; unset while in flight. */
  settledAt?: number;
}

/** The changes a read may not show, each Thread's oldest first. */
export type Unseen = ReadonlyMap<ThreadId, ReadonlyArray<RequestedChange>>;

/**
 * The changes this page requested that a server read may predate. A read
 * that started before a change's answer can return the Thread as it was:
 * a list refetched after one archive answers still shows the next archive's
 * Thread active, because that request has not reached the server yet. Every
 * read of Threads goes through `read`, which applies each change the read
 * cannot have seen, so the page shows the newest state the person asked for
 * whatever order reads and answers land in.
 */
class RequestedChanges {
  #clock = 0;
  #entries: RequestedChangeEntry[] = [];
  /** Start times of reads still in flight. */
  readonly #reads = new Set<number>();

  /**
   * The last row each archived or restored Thread showed: an Undo before
   * any loaded list holds the Thread (the Archived section is closed) puts
   * this row back instead of the Thread vanishing until a refetch.
   */
  readonly #rows = new Map<ThreadId, Listed>();

  request(change: RequestedChange): RequestedChangeEntry {
    const entry: RequestedChangeEntry = { ...change };
    if (change.row !== undefined) this.#rows.set(change.threadId, change.row);
    this.#entries.push(entry);
    return entry;
  }

  /** The row the Thread last showed when a change moved it. */
  row(threadId: ThreadId) {
    return this.#rows.get(threadId);
  }

  /** The server applied it: reads from now on show it themselves. */
  settle(entry: RequestedChangeEntry | undefined) {
    if (entry === undefined || entry.settledAt !== undefined) return;
    this.#clock += 1;
    entry.settledAt = this.#clock;
    this.#prune();
  }

  /** The server refused it: the Thread reads as the server has it. */
  drop(entry: RequestedChangeEntry | undefined) {
    this.#entries = this.#entries.filter((other) => other !== entry);
  }

  /** Changes still waiting on the server for one Thread, oldest first. */
  pending(threadId: ThreadId): ReadonlyArray<RequestedChange> {
    return this.#entries.filter(
      (entry) => entry.threadId === threadId && entry.settledAt === undefined,
    );
  }

  /** Reads from the server, then applies the changes the read may predate. */
  async read<Data>(
    read: () => Promise<Data>,
    overlay: (data: Data, unseen: Unseen) => Data,
  ): Promise<Data> {
    this.#clock += 1;
    const startedAt = this.#clock;
    this.#reads.add(startedAt);
    try {
      const data = await read();
      const unseen = new Map<ThreadId, RequestedChange[]>();
      for (const entry of this.#entries)
        if (entry.settledAt === undefined || startedAt < entry.settledAt)
          unseen.set(entry.threadId, [
            ...(unseen.get(entry.threadId) ?? []),
            entry,
          ]);
      return unseen.size === 0 ? data : overlay(data, unseen);
    } finally {
      this.#reads.delete(startedAt);
      this.#prune();
    }
  }

  /** Forgets answered changes no read in flight started before. */
  #prune() {
    const oldest = Math.min(...this.#reads);
    this.#entries = this.#entries.filter(
      (entry) => entry.settledAt === undefined || entry.settledAt > oldest,
    );
  }
}

const ledgers = new WeakMap<QueryClient, RequestedChanges>();

export const requestedChanges = (client: QueryClient) => {
  let ledger = ledgers.get(client);
  if (ledger === undefined) {
    ledger = new RequestedChanges();
    ledgers.set(client, ledger);
  }
  return ledger;
};

/** The Thread with each change applied, oldest first. */
export const withChanges = <Thread extends ThreadData>(
  thread: Thread,
  changes: ReadonlyArray<RequestedChange> | undefined,
): Thread =>
  changes === undefined
    ? thread
    : changes.reduce((next, change) => change.apply(next), thread);

/** The lifecycle the newest change that sets one leaves. */
export const lifecycleOf = (changes: ReadonlyArray<RequestedChange>) =>
  changes.findLast((change) => change.lifecycleState !== undefined)
    ?.lifecycleState;

/** Puts a row at its place by list order. */
const placed = (rows: ReadonlyArray<Listed>, row: Listed) => {
  const others = rows.filter(({ id }) => id !== row.id);
  const at = others.findIndex((other) => listOrder(row, other) < 0);
  return at === -1
    ? [...others, row]
    : [...others.slice(0, at), row, ...others.slice(at)];
};

/**
 * One fetched list page with the changes it may predate: a Thread archived
 * or restored joins or leaves it, and a pin or rename shows. A Thread the
 * page lacks joins only where the page's range of the list order holds it.
 */
export const pageWithChanges = (
  page: ThreadPage,
  queryKey: readonly unknown[],
  firstPage: boolean,
  unseen: Unseen,
  /** The row as the page last showed it, for a Thread the server left out. */
  cachedRow: (threadId: ThreadId) => Listed | undefined,
): ThreadPage => {
  let items: ReadonlyArray<Listed> = page.items;
  let children = page.children;
  for (const [threadId, changes] of unseen) {
    const lifecycleState = lifecycleOf(changes);
    // A roots list carries its roots' children beside them.
    const listLifecycle = (
      queryKey[3] as { readonly lifecycleState?: string | null } | undefined
    )?.lifecycleState;
    const keep = (row: Listed) =>
      listLifecycle == null || listLifecycle === row.lifecycleState;
    const inItems = items.find(({ id }) => id === threadId);
    const inChildren = children?.find(({ id }) => id === threadId);
    if (inItems !== undefined) {
      const row = withChanges(inItems, changes);
      items = keep(row)
        ? placed(items, row)
        : items.filter(({ id }) => id !== threadId);
    }
    if (inChildren !== undefined && children !== undefined) {
      const row = withChanges(inChildren, changes);
      children = keep(row)
        ? children.map((child) => (child.id === threadId ? row : child))
        : children.filter(({ id }) => id !== threadId);
    }
    if (
      inItems !== undefined ||
      inChildren !== undefined ||
      lifecycleState === undefined
    )
      continue;
    const source =
      cachedRow(threadId) ?? changes.findLast(({ row }) => row)?.row;
    if (source === undefined) continue;
    const row = withChanges({ ...source, lifecycleState } as Listed, changes);
    if (!listAdmits(queryKey, row)) continue;
    const first = items[0];
    const last = items.at(-1);
    const fromStart =
      firstPage || (first !== undefined && listOrder(first, row) < 0);
    const toEnd =
      page.nextCursor === undefined ||
      (last !== undefined && listOrder(row, last) < 0);
    if (fromStart && toEnd) items = placed(items, row);
  }
  return items === page.items && children === page.children
    ? page
    : {
        ...page,
        items: [...items],
        ...(children === undefined ? {} : { children }),
      };
};

/** The Thread's row in a cached list, root or child. */
export const listedRow = (data: ListData | undefined, threadId: ThreadId) => {
  for (const page of data?.pages ?? [])
    for (const row of [...page.items, ...(page.children ?? [])])
      if (row.id === threadId) return row;
  return undefined;
};
