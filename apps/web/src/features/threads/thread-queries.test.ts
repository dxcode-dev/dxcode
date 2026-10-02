import type { ProjectData, ThreadDetailData } from "@dx/api";
import {
  defaultThreadModelSelection,
  ProjectId,
  ThreadId,
  UserId,
} from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectKeys } from "../projects/project-queries.js";
import {
  createThreadMutationOptions,
  optimisticThreadData,
  setThreadArchivedMutationOptions,
} from "./thread-mutations.js";
import {
  threadKeys,
  threadQueryOptions,
  threadsQueryOptions,
} from "./thread-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const otherProjectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000002",
);
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);
const project = { id: projectId } as ProjectData;

afterEach(() => vi.unstubAllGlobals());

describe("thread query contracts", () => {
  it("uses distinct semantic list keys and forwards only the server cursor", () => {
    const all = threadsQueryOptions(userId);
    const project = threadsQueryOptions(userId, projectId);
    const archived = threadsQueryOptions(userId, undefined, "archived");

    expect(all.queryKey).toEqual(threadKeys.list(userId));
    expect(project.queryKey).toEqual(threadKeys.list(userId, projectId));
    expect(archived.queryKey).toEqual(
      threadKeys.list(userId, undefined, "archived"),
    );
    expect(archived.queryKey).not.toEqual(all.queryKey);
    expect(project.queryKey).not.toEqual(all.queryKey);
    expect(
      project.getNextPageParam?.(
        { items: [], nextCursor: "next" as never },
        [],
        undefined,
        [],
      ),
    ).toBe("next");
    expect(
      project.getNextPageParam?.({ items: [] }, [], undefined, []),
    ).toBeUndefined();
  });

  it("polls only readiness while an existing detail is unready", async () => {
    const detail = {
      id: threadId,
      executionWorkspace: { ready: false, preparationStatus: null },
      agentInitialization: { retained: true },
    } as never;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: { ready: false, preparationStatus: "Preparing source" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    client.setQueryData(threadKeys.detail(userId, threadId), detail);

    const result = await client.fetchQuery({
      ...threadQueryOptions(userId, threadId),
      staleTime: 0,
    });

    expect(result).toMatchObject({
      agentInitialization: { retained: true },
      executionWorkspace: {
        ready: false,
        preparationStatus: "Preparing source",
      },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/v1/threads/${threadId}/readiness`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fetches full detail while a title is pending, even before readiness", async () => {
    const pendingDetail = {
      id: threadId,
      title: "Fallback title",
      titlePending: true,
      projectId,
      visibility: "private",
      lifecycleState: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      lastActivityAt: "2026-08-25T00:00:00.000Z",
      activityStatus: "idle",
      agentUrl: `/v1/agents/dx/${threadId}`,
      executionWorkspace: { ready: false, preparationStatus: null },
      agentInitialization: {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        selection: defaultThreadModelSelection(),
        mcpConnections: [],
        plugins: [],
        skills: [],
      },
    } as unknown as ThreadDetailData;
    const { titlePending: _pending, ...settled } = pendingDetail;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: { ...settled, title: "OAuth refresh retries" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    client.setQueryData(threadKeys.detail(userId, threadId), pendingDetail);
    const options = threadQueryOptions(userId, threadId);

    const result = await client.fetchQuery({ ...options, staleTime: 0 });

    expect(result.title).toBe("OAuth refresh retries");
    expect(result.titlePending).toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/v1/threads/${threadId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const refetchInterval = options.refetchInterval as (query: {
      state: { data: ThreadDetailData };
    }) => number | false;
    expect(
      refetchInterval({
        state: {
          data: {
            ...pendingDetail,
            executionWorkspace: { ready: true, preparationStatus: null },
          },
        },
      }),
    ).toBeGreaterThan(0);
  });

  it("refreshes the full detail when readiness crosses to ready", async () => {
    const staleDetail = {
      id: threadId,
      title: "Stale while preparing",
      projectId,
      visibility: "private",
      lifecycleState: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      lastActivityAt: "2026-08-25T00:00:00.000Z",
      activityStatus: "idle",
      agentUrl: `/v1/agents/dx/${threadId}`,
      executionWorkspace: { ready: false, preparationStatus: null },
      agentInitialization: {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        selection: defaultThreadModelSelection(),
        mcpConnections: [],
        plugins: [],
        skills: [],
      },
    } as unknown as ThreadDetailData;
    const authoritativeDetail = {
      ...staleDetail,
      title: "Authoritative after ready",
      executionWorkspace: { ready: true, preparationStatus: null },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { ready: true, preparationStatus: null },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: authoritativeDetail }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    client.setQueryData(threadKeys.detail(userId, threadId), staleDetail);

    const result = await client.fetchQuery({
      ...threadQueryOptions(userId, threadId),
      staleTime: 0,
    });

    expect(result).toMatchObject({
      title: "Authoritative after ready",
      executionWorkspace: { ready: true },
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `/v1/threads/${threadId}/readiness`,
      `/v1/threads/${threadId}`,
    ]);
  });

  it("seeds detail, all-thread, and matching project caches immediately", async () => {
    const thread = {
      id: threadId,
      title: "Test thread",
      projectId,
      visibility: "private",
      lifecycleState: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      lastActivityAt: "2026-08-25T00:00:00.000Z",
      activityStatus: "idle",
      agentUrl: "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000001",
      executionWorkspace: { ready: false, preparationStatus: null },
      agentInitialization: {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        selection: defaultThreadModelSelection(),
        mcpConnections: [],
        plugins: [],
        skills: [],
      },
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          data: thread,
          initialSubmission: { submissionId: "submission-initial" },
        }),
      ),
    );
    const queryClient = new QueryClient();
    for (const key of [
      threadKeys.list(userId),
      threadKeys.list(userId, projectId),
      threadKeys.list(userId, otherProjectId),
    ]) {
      queryClient.setQueryData(key, {
        pages: [{ items: [], nextCursor: "next" }],
        pageParams: [undefined],
      });
    }
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createThreadMutationOptions(queryClient, userId));
    const initialMessage = {
      body: "Keep this prompt after reload.",
      attachments: [
        {
          type: "image" as const,
          data: "aGVsbG8=",
          mimeType: "image/png" as const,
          filename: "proof.png",
        },
      ],
    };
    const initialThreadId = threadId;

    const created = await mutation.execute({
      project,
      title: "Test thread",
      selection: defaultThreadModelSelection(),
      threadId: initialThreadId,
      optimisticThread: optimisticThreadData(
        initialThreadId,
        projectId,
        "Test thread",
      ),
      initialMessage,
    });
    const detail = await queryClient.fetchQuery(
      threadQueryOptions(userId, threadId),
    );

    expect(detail).toBe(created.data);
    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(project);
    for (const key of [
      threadKeys.list(userId),
      threadKeys.list(userId, projectId),
    ]) {
      expect(queryClient.getQueryData(key)).toEqual({
        pages: [
          {
            items: [{ ...created.data, mode: "medium" }],
            nextCursor: "next",
          },
        ],
        pageParams: [undefined],
      });
    }
    expect(
      queryClient.getQueryData(threadKeys.list(userId, otherProjectId)),
    ).toEqual({
      pages: [{ items: [], nextCursor: "next" }],
      pageParams: [undefined],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/v1/threads",
      expect.objectContaining({ method: "POST" }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      projectId,
      title: "Test thread",
      selection: defaultThreadModelSelection(),
      threadId: initialThreadId,
      initialMessage,
    });
  });

  it("does not replace newer project detail with stale list data when creation fails", async () => {
    const staleListProject = { id: projectId, revision: 1 } as ProjectData;
    const newerDetailProject = { id: projectId, revision: 2 } as ProjectData;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("failed")),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(
      projectKeys.detail(userId, projectId),
      newerDetailProject,
    );
    queryClient.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [staleListProject] }],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createThreadMutationOptions(queryClient, userId));

    await expect(
      mutation.execute({
        project: staleListProject,
        title: "Test thread",
        selection: defaultThreadModelSelection(),
      }),
    ).rejects.toThrow("failed");

    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(newerDetailProject);
  });

  it("removes only the failed optimistic row when initial admission fails", async () => {
    const existing = {
      id: "thr_00000000-0000-4000-8000-000000000099",
      projectId,
    } as ThreadDetailData;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("failed")),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const key = threadKeys.list(userId, undefined, "active");
    queryClient.setQueryData(key, {
      pages: [{ items: [existing] }],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createThreadMutationOptions(queryClient, userId));
    const optimistic = optimisticThreadData(
      threadId,
      projectId,
      "Failed optimistic thread",
    );

    await expect(
      mutation.execute({
        project,
        title: "Failed optimistic thread",
        selection: defaultThreadModelSelection(),
        threadId,
        optimisticThread: optimistic,
        initialMessage: { body: "Restore this", attachments: [] },
      }),
    ).rejects.toThrow("failed");

    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: ThreadDetailData[] }>;
      }>(key)?.pages[0]?.items,
    ).toEqual([existing]);
  });

  it("moves a Thread into archived caches before sandbox pause completes", async () => {
    const detail = {
      id: threadId,
      title: "Archive immediately",
      projectId,
      visibility: "private",
      lifecycleState: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      lastActivityAt: "2026-08-25T00:00:00.000Z",
      activityStatus: "idle",
      pinnedAt: "2026-08-25T01:00:00.000Z",
      agentUrl: "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000001",
      executionWorkspace: { ready: true, preparationStatus: null },
      agentInitialization: {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        selection: defaultThreadModelSelection(),
        mcpConnections: [],
        plugins: [],
        skills: [],
      },
    } as const;
    const { agentInitialization: _agentInitialization, ...thread } = detail;
    const deferred = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => deferred.promise),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadKeys.detail(userId, threadId), detail);
    queryClient.setQueryData(threadKeys.list(userId), {
      pages: [
        {
          items: [{ ...thread, pinnedAt: "2026-08-25T01:00:00.000Z" as const }],
        },
      ],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        setThreadArchivedMutationOptions(queryClient, userId),
      );

    const archive = mutation.execute({ threadId, archived: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    expect(
      queryClient.getQueryData<typeof detail>(
        threadKeys.detail(userId, threadId),
      ),
    ).toMatchObject({ lifecycleState: "archived", pinnedAt: undefined });
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: Array<typeof thread & { pinnedAt?: string }> }>;
      }>(threadKeys.list(userId))?.pages[0]?.items[0],
    ).toMatchObject({ lifecycleState: "archived", pinnedAt: undefined });

    deferred.resolve(
      Response.json({
        status: "success",
        data: { ...thread, lifecycleState: "archived", pinnedAt: undefined },
      }),
    );
    await archive;
  });

  it("restores detail and list caches when archiving fails", async () => {
    const detail = {
      id: threadId,
      lifecycleState: "active",
      pinnedAt: "2026-08-25T01:00:00.000Z",
      retained: "detail",
    } as const;
    const list = {
      pages: [
        {
          items: [
            {
              id: threadId,
              lifecycleState: "active",
              pinnedAt: "2026-08-25T01:00:00.000Z",
              retained: "list",
            },
          ],
        },
      ],
      pageParams: [undefined],
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("failed")),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(threadKeys.detail(userId, threadId), detail);
    queryClient.setQueryData(threadKeys.list(userId), list);
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        setThreadArchivedMutationOptions(queryClient, userId),
      );

    await expect(
      mutation.execute({ threadId, archived: true }),
    ).rejects.toThrow("failed");

    expect(
      queryClient.getQueryData(threadKeys.detail(userId, threadId)),
    ).toEqual(detail);
    expect(queryClient.getQueryData(threadKeys.list(userId))).toEqual(list);
  });
});
