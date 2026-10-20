// @vitest-environment happy-dom

import { ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  InfiniteQueryObserver,
  type QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadListClientItem } from "../../../shared/api/client.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import {
  sharedThreadsQueryOptions,
  THREAD_FRESHNESS_SLO_MS,
  threadKeys,
  threadsQueryOptions,
} from "../thread-queries.js";
import { THREAD_ROW_COALESCE_MS } from "../thread-row-queries.js";
import { RealtimeClient } from "./realtime-client.js";

class FakeSocket {
  readonly readyState = WebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send() {}
  close() {}
  receive(value: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

const userId = Schema.decodeUnknownSync(UserId)(
  "usr_00000000-0000-4000-8000-000000000001",
);
const id = (index: number) =>
  Schema.decodeUnknownSync(ThreadId)(
    `thr_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 19, 9, 0, second)).toISOString();

interface ServerThread {
  readonly id: ThreadId;
  lastActivity: number;
  activityStatus: "idle" | "working";
  lifecycleState: "active" | "archived";
  changes?: { additions: number; deletions: number; files: number };
}

/**
 * Core's Thread list, row, and shared list routes over in-memory Threads,
 * counting each request. `pageSize` pages the roots lists.
 */
const fakeCore = (threads: ServerThread[], pageSize = 100) => {
  const requests = { list: 0, row: 0, shared: 0, other: 0 };
  const row = (thread: ServerThread) => ({
    id: thread.id,
    title: `Thread ${thread.id.slice(-3)}`,
    projectId: "prj_00000000-0000-4000-8000-000000000001",
    visibility: "private",
    createdAt: at(0),
    updatedAt: at(0),
    lastActivityAt: at(thread.lastActivity),
    activityStatus: thread.activityStatus,
    lifecycleState: thread.lifecycleState,
    agentUrl: `/v1/agents/dx/${thread.id}`,
    mode: "medium",
    ...(thread.changes === undefined ? {} : { changes: thread.changes }),
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.href);
    const rowMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/list-item$/);
    if (rowMatch !== null) {
      requests.row += 1;
      const thread = threads.find(({ id }) => id === rowMatch[1]);
      return thread === undefined
        ? json(
            {
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread not found.",
                requestId: "test",
              },
            },
            404,
          )
        : json({ status: "success", data: row(thread) });
    }
    if (url.pathname === "/v1/threads") {
      requests.list += 1;
      const ordered = threads
        .filter(
          ({ lifecycleState }) =>
            lifecycleState === url.searchParams.get("lifecycleState"),
        )
        .sort(
          (a, b) => b.lastActivity - a.lastActivity || (a.id < b.id ? 1 : -1),
        );
      const page = Number(url.searchParams.get("cursor")?.slice(1, 2) ?? "0");
      const items = ordered.slice(page * pageSize, (page + 1) * pageSize);
      return json({
        status: "success",
        data: {
          items: items.map(row),
          children: [],
          ...(ordered.length > (page + 1) * pageSize
            ? { nextCursor: `p${page + 1}xx` }
            : {}),
        },
      });
    }
    if (url.pathname === "/v1/shared-threads") {
      requests.shared += 1;
      return json({ status: "success", data: { items: [] } });
    }
    requests.other += 1;
    return json({}, 404);
  });
  return requests;
};

/** The sidebar's queries: active roots, optionally archived roots, shared. */
const sidebar = async (queryClient: QueryClient, archived = false) => {
  const lists = [
    new InfiniteQueryObserver(
      queryClient,
      threadsQueryOptions(userId, undefined, "active", "roots"),
    ),
    ...(archived
      ? [
          new InfiniteQueryObserver(
            queryClient,
            threadsQueryOptions(userId, undefined, "archived", "roots"),
          ),
        ]
      : []),
  ];
  const shared = new QueryObserver(
    queryClient,
    sharedThreadsQueryOptions(userId),
  );
  const stops = [...lists, shared].map((observer) =>
    observer.subscribe(() => undefined),
  );
  await vi.waitFor(() =>
    expect(
      [...lists, shared].every(
        (observer) => observer.getCurrentResult().isSuccess,
      ),
    ).toBe(true),
  );
  return () => {
    for (const stop of stops) stop();
  };
};

const rows = (
  queryClient: QueryClient,
  lifecycleState: "active" | "archived" = "active",
) =>
  (
    queryClient.getQueryData(
      threadKeys.list(userId, undefined, lifecycleState, "roots"),
    ) as { pages: Array<{ items: ThreadListClientItem[] }> } | undefined
  )?.pages.flatMap((page) => page.items) ?? [];

const connect = (queryClient: QueryClient) => {
  const socket = new FakeSocket();
  const client = new RealtimeClient(queryClient, userId, () => socket);
  client.start();
  socket.receive({ type: "ready", revision: 0 });
  let revision = 0;
  return {
    client,
    hint: (
      type: "thread.invalidated" | "changes.invalidated",
      threadId: ThreadId,
      extra: Record<string, unknown> = {},
    ) => {
      revision += 1;
      socket.receive({ type, threadId, revision, ...extra });
    },
  };
};

/** Lets coalesced hints flush and their reads land. */
const settle = () =>
  new Promise((resolve) => setTimeout(resolve, THREAD_ROW_COALESCE_MS + 100));

afterEach(() => vi.unstubAllGlobals());

describe("Sidebar rows from realtime hints", () => {
  it("patches a listed Thread's row from one row read: working, then idle, moved to the top", async () => {
    const threads: ServerThread[] = [1, 2, 3].map((index) => ({
      id: id(index),
      lastActivity: 10 - index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const stop = await sidebar(queryClient);
    const [first, second] = rows(queryClient);
    expect(rows(queryClient).map(({ id }) => id)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    const { client, hint } = connect(queryClient);

    // The oldest Thread starts a turn.
    Object.assign(threads[2] as ServerThread, {
      lastActivity: 20,
      activityStatus: "working",
    });
    hint("thread.invalidated", id(3));
    await vi.waitFor(() =>
      expect(rows(queryClient)[0]).toMatchObject({
        id: id(3),
        activityStatus: "working",
      }),
    );
    expect(rows(queryClient).map(({ id }) => id)).toEqual([
      id(3),
      id(1),
      id(2),
    ]);
    // Untouched rows keep their identity, so their sidebar rows skip render.
    expect(rows(queryClient)[1]).toBe(first);
    expect(rows(queryClient)[2]).toBe(second);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: threadKeys.detail(userId, id(3)),
    });

    // It settles.
    Object.assign(threads[2] as ServerThread, {
      lastActivity: 21,
      activityStatus: "idle",
    });
    hint("thread.invalidated", id(3));
    await vi.waitFor(() =>
      expect(rows(queryClient)[0]).toMatchObject({
        id: id(3),
        activityStatus: "idle",
      }),
    );
    expect(requests).toEqual({ list: 1, row: 2, shared: 1, other: 0 });
    client.stop();
    stop();
  });

  it("reads a Thread's row once for ten quick hints", async () => {
    const threads: ServerThread[] = [1, 2].map((index) => ({
      id: id(index),
      lastActivity: index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient);
    const { client, hint } = connect(queryClient);

    for (let index = 0; index < 10; index++) hint("thread.invalidated", id(1));
    await settle();
    expect(requests).toEqual({ list: 1, row: 1, shared: 1, other: 0 });
    client.stop();
    stop();
  });

  it("refetches the lists for a Thread no list holds, or one that is gone", async () => {
    const threads: ServerThread[] = [
      {
        id: id(1),
        lastActivity: 1,
        activityStatus: "idle",
        lifecycleState: "active",
      },
    ];
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient);
    const { client, hint } = connect(queryClient);

    // A new Thread.
    threads.push({
      id: id(2),
      lastActivity: 2,
      activityStatus: "working",
      lifecycleState: "active",
    });
    hint("thread.invalidated", id(2));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([id(2), id(1)]),
    );
    expect(requests).toEqual({ list: 2, row: 0, shared: 2, other: 0 });

    // A deleted one: its row read answers 404.
    threads.splice(0, 1);
    hint("thread.invalidated", id(1));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([id(2)]),
    );
    expect(requests).toEqual({ list: 3, row: 1, shared: 3, other: 0 });
    client.stop();
    stop();
  });

  it("moves an archived Thread to the archive and an unarchived one back", async () => {
    const threads: ServerThread[] = [1, 2].map((index) => ({
      id: id(index),
      lastActivity: index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient, true);
    const { client, hint } = connect(queryClient);

    (threads[0] as ServerThread).lifecycleState = "archived";
    hint("thread.invalidated", id(1));
    await vi.waitFor(() =>
      expect(rows(queryClient, "archived").map(({ id }) => id)).toEqual([
        id(1),
      ]),
    );
    expect(rows(queryClient).map(({ id }) => id)).toEqual([id(2)]);

    (threads[0] as ServerThread).lifecycleState = "active";
    hint("thread.invalidated", id(1));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([id(2), id(1)]),
    );
    expect(rows(queryClient, "archived")).toEqual([]);
    // Each read found a structural change and refetched both lists.
    expect(requests).toEqual({ list: 6, row: 2, shared: 3, other: 0 });
    client.stop();
    stop();
  });

  it("refetches one list when a row's new place is on another loaded page", async () => {
    const threads: ServerThread[] = [1, 2, 3, 4].map((index) => ({
      id: id(index),
      lastActivity: 10 - index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads, 2);
    const queryClient = createQueryClient();
    const observer = new InfiniteQueryObserver(
      queryClient,
      threadsQueryOptions(userId, undefined, "active", "roots"),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isSuccess).toBe(true),
    );
    await observer.fetchNextPage();
    expect(rows(queryClient).map(({ id }) => id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ]);
    expect(requests.list).toBe(2);
    const { client, hint } = connect(queryClient);

    // Within its page: patched in place.
    (threads[3] as ServerThread).lastActivity = 7.5;
    hint("thread.invalidated", id(4));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([
        id(1),
        id(2),
        id(4),
        id(3),
      ]),
    );
    await settle();
    expect(requests).toEqual({ list: 2, row: 1, shared: 0, other: 0 });

    // Ahead of the first page: Core pages the list again.
    (threads[3] as ServerThread).lastActivity = 30;
    hint("thread.invalidated", id(4));
    await vi.waitFor(() => expect(requests.list).toBe(4));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([
        id(4),
        id(1),
        id(2),
        id(3),
      ]),
    );
    expect(requests.row).toBe(2);
    client.stop();
    unsubscribe();
  });

  it("refetches a list that should now show a Thread another list holds", async () => {
    const threads: ServerThread[] = [1, 2, 3].map((index) => ({
      id: id(index),
      lastActivity: 10 - index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads, 2);
    const queryClient = createQueryClient();
    // The sidebar loaded its first page; a Project page loaded both.
    const sidebarList = new InfiniteQueryObserver(
      queryClient,
      threadsQueryOptions(userId, undefined, "active", "roots"),
    );
    const projectList = new InfiniteQueryObserver(
      queryClient,
      threadsQueryOptions(
        userId,
        Schema.decodeUnknownSync(ProjectId)(
          "prj_00000000-0000-4000-8000-000000000001",
        ),
        "active",
      ),
    );
    const stops = [sidebarList, projectList].map((observer) =>
      observer.subscribe(() => undefined),
    );
    await vi.waitFor(() =>
      expect(
        [sidebarList, projectList].every(
          (observer) => observer.getCurrentResult().isSuccess,
        ),
      ).toBe(true),
    );
    await projectList.fetchNextPage();
    expect(rows(queryClient).map(({ id }) => id)).toEqual([id(1), id(2)]);
    const listsBefore = requests.list;
    const { client, hint } = connect(queryClient);

    // The oldest Thread starts a turn: it belongs at the top of the sidebar.
    (threads[2] as ServerThread).lastActivity = 30;
    hint("thread.invalidated", id(3));
    await vi.waitFor(() =>
      expect(rows(queryClient).map(({ id }) => id)).toEqual([id(3), id(1)]),
    );
    expect(requests.list).toBeGreaterThan(listsBefore);
    client.stop();
    for (const stop of stops) stop();
  });

  it("patches Changes totals from the row only for lists whose totals may be stale", async () => {
    const totals = { additions: 3, deletions: 1, files: 1 };
    const threads: ServerThread[] = [
      {
        id: id(1),
        lastActivity: 1,
        activityStatus: "working",
        lifecycleState: "active",
        changes: totals,
      },
    ];
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient);
    // Another Project's list, which does not hold the Thread.
    const otherProject = new InfiniteQueryObserver(
      queryClient,
      threadsQueryOptions(
        userId,
        Schema.decodeUnknownSync(ProjectId)(
          "prj_00000000-0000-4000-8000-000000000002",
        ),
      ),
    );
    const stopOther = otherProject.subscribe(() => undefined);
    await vi.waitFor(() =>
      expect(otherProject.getCurrentResult().isSuccess).toBe(true),
    );
    const { client, hint } = connect(queryClient);

    // An unchanged capture: the list's totals are current.
    hint("changes.invalidated", id(1));
    await settle();
    expect(requests).toEqual({ list: 2, row: 0, shared: 1, other: 0 });

    // Moved totals: one row read, no list request.
    (threads[0] as ServerThread).changes = {
      additions: 9,
      deletions: 2,
      files: 3,
    };
    hint("changes.invalidated", id(1), { summaryChanged: true });
    await vi.waitFor(() =>
      expect(rows(queryClient)[0]?.changes).toEqual({
        additions: 9,
        deletions: 2,
        files: 3,
      }),
    );
    expect(requests).toEqual({ list: 2, row: 1, shared: 1, other: 0 });

    // Stale Changes leave the row without totals, so the next capture reads
    // it again even though its totals did not move.
    delete (threads[0] as ServerThread).changes;
    hint("changes.invalidated", id(1), { summaryChanged: true });
    await vi.waitFor(() =>
      expect(rows(queryClient)[0]).not.toHaveProperty("changes"),
    );
    (threads[0] as ServerThread).changes = totals;
    hint("changes.invalidated", id(1));
    await vi.waitFor(() =>
      expect(rows(queryClient)[0]?.changes).toEqual(totals),
    );
    expect(requests).toEqual({ list: 2, row: 3, shared: 1, other: 0 });
    client.stop();
    stopOther();
    stop();
  });

  it("measures row reads and list refetches for a minute of Changes captures", async () => {
    // dxd hints at most once a second while a Thread writes files.
    const run = async (moved: number) => {
      const threads: ServerThread[] = [
        {
          id: id(1),
          lastActivity: 1,
          activityStatus: "working",
          lifecycleState: "active",
          changes: { additions: 0, deletions: 0, files: 1 },
        },
      ];
      const requests = fakeCore(threads);
      const queryClient = createQueryClient();
      const stop = await sidebar(queryClient);
      const { client, hint } = connect(queryClient);
      vi.useFakeTimers();
      for (let second = 0; second < 60; second++) {
        const summaryChanged = second < moved;
        if (summaryChanged)
          (threads[0] as ServerThread).changes = {
            additions: second + 1,
            deletions: 0,
            files: 1,
          };
        hint(
          "changes.invalidated",
          id(1),
          summaryChanged ? { summaryChanged: true } : {},
        );
        await vi.advanceTimersByTimeAsync(1_000);
      }
      vi.useRealTimers();
      expect(rows(queryClient)[0]?.changes?.additions).toBe(moved);
      client.stop();
      stop();
      return { listRefetches: requests.list - 1, rowReads: requests.row };
    };

    const measured = {
      scenario:
        "60 changes.invalidated hints in a minute for one working Thread, one loaded Thread list",
      before:
        "PR 913 refetched each list holding the Thread when its totals moved: 0, 10, and 60 list refetches",
      perMinute: {
        noTotalsMoved: await run(0),
        tenTotalsMoved: await run(10),
        everyTotalsMoved: await run(60),
      },
    };
    expect(measured.perMinute).toEqual({
      noTotalsMoved: { listRefetches: 0, rowReads: 0 },
      tenTotalsMoved: { listRefetches: 0, rowReads: 10 },
      everyTotalsMoved: { listRefetches: 0, rowReads: 60 },
    });
    await expect(`${JSON.stringify(measured, null, 2)}\n`).toMatchFileSnapshot(
      "../../../../../../artifacts/sidebar-row-patch/changes-minute.json",
    );
  });

  it("keeps the minute safety refetch while one Thread's hints keep patching its row", async () => {
    const threads: ServerThread[] = [1, 2].map((index) => ({
      id: id(index),
      lastActivity: index,
      activityStatus: "idle",
      lifecycleState: "active",
    }));
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient);
    const { client, hint } = connect(queryClient);
    const listQuery = queryClient.getQueryCache().find({
      queryKey: threadKeys.list(userId, undefined, "active", "roots"),
    });
    const fetchedAt = listQuery?.state.dataUpdatedAt;

    // A patch is not a fetch: the list still dates from its last fetch.
    (threads[0] as ServerThread).activityStatus = "working";
    hint("thread.invalidated", id(1));
    await vi.waitFor(() =>
      expect(
        rows(queryClient).find((row) => row.id === id(1))?.activityStatus,
      ).toBe("working"),
    );
    expect(listQuery?.state.dataUpdatedAt).toBe(fetchedAt);
    expect(requests).toEqual({ list: 1, row: 1, shared: 1, other: 0 });

    // Another row changed without a hint. Patches restart the list's poll
    // timer, so the first hint a minute after the last fetch refetches it.
    (threads[1] as ServerThread).activityStatus = "working";
    listQuery?.setState({
      dataUpdatedAt: Date.now() - THREAD_FRESHNESS_SLO_MS,
    });
    (threads[0] as ServerThread).activityStatus = "idle";
    hint("thread.invalidated", id(1));
    await vi.waitFor(() =>
      expect(rows(queryClient).map((row) => row.activityStatus)).toEqual([
        "working",
        "idle",
      ]),
    );
    expect(requests).toEqual({ list: 2, row: 2, shared: 1, other: 0 });
    client.stop();
    stop();
  });

  it("measures the requests one turn costs a viewer whose sidebar holds 100 roots", async () => {
    const threads: ServerThread[] = Array.from({ length: 100 }, (_, index) => ({
      id: id(index + 1),
      lastActivity: 100 - index,
      activityStatus: "idle",
      lifecycleState: "active",
      changes: { additions: 1, deletions: 0, files: 1 },
    }));
    const requests = fakeCore(threads);
    const queryClient = createQueryClient();
    const stop = await sidebar(queryClient);
    const { client, hint } = connect(queryClient);
    const working = threads[99] as ServerThread;

    // As PR 913's hints arrive for one turn: queued, three captures (two
    // moving totals), settled.
    const turn = [
      { type: "thread.invalidated", activity: 200, status: "working" },
      { type: "changes.invalidated", summaryChanged: true },
      { type: "changes.invalidated" },
      { type: "changes.invalidated", summaryChanged: true },
      { type: "thread.invalidated", activity: 201, status: "idle" },
    ] as const;
    const before = {
      list: requests.list,
      row: requests.row,
      shared: requests.shared,
    };
    for (const step of turn) {
      if (step.type === "thread.invalidated") {
        working.lastActivity = step.activity;
        working.activityStatus = step.status;
      } else if ("summaryChanged" in step)
        working.changes = {
          additions: (working.changes?.additions ?? 0) + 1,
          deletions: 0,
          files: 1,
        };
      hint(
        step.type,
        working.id,
        "summaryChanged" in step ? { summaryChanged: true } : {},
      );
      await settle();
    }
    expect(rows(queryClient)[0]).toMatchObject({
      id: working.id,
      activityStatus: "idle",
      changes: { additions: 3 },
    });
    const after = {
      list: requests.list - before.list,
      shared: requests.shared - before.shared,
      row: requests.row - before.row,
    };
    expect(after).toEqual({ list: 0, shared: 0, row: 4 });
    // PR 913's rules for the same hints: each thread.invalidated refetched
    // the roots list and the shared list; each summaryChanged refetched the
    // roots list.
    const previous = { list: 2 + 2, shared: 2, row: 0 };
    await expect(
      `${JSON.stringify(
        {
          scenario:
            "One turn of a Thread in a sidebar of 100 roots: thread.invalidated when queued and settled, three changes.invalidated of which two moved totals",
          before: { ...previous, threadRowsReturned: previous.list * 100 },
          after: { ...after, threadRowsReturned: after.row },
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      "../../../../../../artifacts/sidebar-row-patch/requests-per-turn.json",
    );
    client.stop();
    stop();
  });
});
