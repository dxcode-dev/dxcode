import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheCreatedThread,
  cacheOptimisticThread,
  optimisticThreadData,
  rollbackOptimisticThread,
} from "./thread-mutations.js";
import { threadKeys, threadsQueryOptions } from "./thread-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const created = {
  id: "thread-created",
  projectId: "project-1",
  agentInitialization: { selection: defaultThreadModelSelection() },
} as unknown as ThreadDetailData;

afterEach(() => vi.unstubAllGlobals());

describe("thread mutation cache ownership", () => {
  it("updates every matching loaded list and rolls back only its own row", async () => {
    const queryClient = new QueryClient();
    const otherProject = "project-2" as typeof created.projectId;
    const existing = {
      id: "thread-existing",
      projectId: created.projectId,
    } as ThreadDetailData;
    const first = optimisticThreadData(
      "thread-first" as typeof created.id,
      created.projectId,
      "First pending thread" as ThreadDetailData["title"],
    );
    const second = optimisticThreadData(
      "thread-second" as typeof created.id,
      created.projectId,
      "Second pending thread" as ThreadDetailData["title"],
    );
    const matching = [
      threadKeys.list(userId),
      threadKeys.list(userId, created.projectId),
      threadKeys.list(userId, created.projectId, "active"),
    ];
    const excluded = [
      threadKeys.list(userId, otherProject),
      threadKeys.list(userId, undefined, "archived"),
    ];
    for (const key of [...matching, ...excluded]) {
      queryClient.setQueryData(key, {
        pages: [{ items: [existing] }],
        pageParams: [undefined],
      });
    }

    await Promise.all([
      cacheOptimisticThread(queryClient, userId, first),
      cacheOptimisticThread(queryClient, userId, second),
    ]);
    rollbackOptimisticThread(queryClient, userId, first);

    for (const key of matching) {
      expect(
        queryClient
          .getQueryData<{
            pages: Array<{ items: ThreadDetailData[] }>;
          }>(key)
          ?.pages[0]?.items.map(({ id }) => id),
      ).toEqual([second.id, existing.id]);
    }
    for (const key of excluded) {
      expect(
        queryClient
          .getQueryData<{
            pages: Array<{ items: ThreadDetailData[] }>;
          }>(key)
          ?.pages[0]?.items.map(({ id }) => id),
      ).toEqual([existing.id]);
    }
  });

  it("replaces the optimistic row with canonical detail without duplication", async () => {
    const queryClient = new QueryClient();
    const listKey = threadKeys.list(userId);
    const optimistic = optimisticThreadData(
      created.id,
      created.projectId,
      "Pending title" as ThreadDetailData["title"],
    );
    queryClient.setQueryData(listKey, {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });

    await cacheOptimisticThread(queryClient, userId, optimistic);
    await cacheCreatedThread(queryClient, userId, created);

    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: ThreadDetailData[] }>;
      }>(listKey)?.pages[0]?.items,
    ).toEqual([{ ...created, mode: "medium" }]);
  });

  it("does not fabricate a successful first page for an unloaded list", async () => {
    const queryClient = new QueryClient();
    const listKey = threadKeys.list(userId);
    queryClient.getQueryCache().build(queryClient, {
      queryKey: listKey,
      queryFn: () => Promise.reject(new Error("unavailable")),
    });

    await cacheCreatedThread(queryClient, userId, created);

    expect(queryClient.getQueryData(listKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(threadKeys.detail(userId, created.id)),
    ).toBe(created);
  });

  it("cancels a stale list request before caching the created thread", async () => {
    const existing = {
      id: "thread-existing",
      projectId: created.projectId,
      agentInitialization: { selection: defaultThreadModelSelection() },
    } as unknown as ThreadDetailData;
    let listSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        listSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          listSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const queryClient = new QueryClient();
    const options = threadsQueryOptions(userId);
    queryClient.setQueryData(options.queryKey, {
      pages: [{ items: [existing] }],
      pageParams: [undefined],
    });
    const stale = queryClient.fetchInfiniteQuery({ ...options, staleTime: 0 });
    void stale.catch(() => undefined);
    await vi.waitFor(() => expect(listSignal).toBeDefined());

    await cacheCreatedThread(queryClient, userId, created);

    expect(listSignal?.aborted).toBe(true);
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: ThreadDetailData[] }>;
      }>(options.queryKey)?.pages[0]?.items,
    ).toEqual([{ ...created, mode: "medium" }, existing]);
  });
});
