// @vitest-environment happy-dom

import { ProjectDataSchema, ThreadDetailDataSchema } from "@dx/api";
import {
  defaultThreadModelSelection,
  ProjectId,
  RunnerProfileId,
  ThreadId,
  UserId,
} from "@dx/domain";
import { createMemoryHistory } from "@tanstack/react-router";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectKeys,
  projectQueryOptions,
} from "./features/projects/project-queries.js";
import { settingsKeys } from "./features/settings/settings-context-queries.js";
import {
  createThreadMutationOptions,
  optimisticThreadData,
} from "./features/threads/thread-mutations.js";
import {
  threadKeys,
  threadQueryOptions,
} from "./features/threads/thread-queries.js";
import { createAppRouter, ensureProjectRouteData } from "./router.js";
import { ApiError } from "./shared/api/client.js";
import { createQueryClient } from "./shared/query/query-client.js";
import { FrontendNetworkHarness } from "./testing/frontend-network-harness.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);
const project = Schema.decodeUnknownSync(ProjectDataSchema)({
  id: projectId,
  name: "Router project",
  configuration: {
    shipAction: "ship",
    commitAuthor: {
      preference: "dx",
      name: "dx",
      email: "noreply@dx.local",
    },
    signingPreference: "disabled",
    runnerProfileId: Schema.decodeUnknownSync(RunnerProfileId)("e2b-default"),
    publicCodeEnabled: false,
  },
  revision: 0,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
});
const thread = Schema.decodeUnknownSync(ThreadDetailDataSchema)({
  id: threadId,
  title: "Test thread",
  projectId,
  visibility: "private",
  lifecycleState: "active",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  lastActivityAt: "2026-08-25T00:00:00.000Z",
  activityStatus: "idle",
  agentUrl: `/v1/agents/dx/${threadId}`,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Router Query coordination", () => {
  it("navigates while thread admission is pending and exposes the optimistic row", async () => {
    const response = Promise.withResolvers<Response>();
    const network = new FrontendNetworkHarness((request) => {
      if (request.method === "POST" && request.url === "/v1/threads")
        return response.promise;
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    const activeList = threadKeys.list(userId, undefined, "active");
    queryClient.setQueryData(activeList, {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createThreadMutationOptions(queryClient, userId));
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/new"] }),
    );
    const optimistic = optimisticThreadData(threadId, projectId, thread.title);

    const admission = mutation.execute({
      project,
      title: thread.title,
      selection: defaultThreadModelSelection(),
      threadId,
      optimisticThread: optimistic,
      initialMessage: { body: "Start immediately", attachments: [] },
    });
    await router.navigate({
      to: "/threads/$threadId",
      params: { threadId },
    });

    expect(router.state.location.pathname).toBe(`/threads/${threadId}`);
    expect(
      queryClient
        .getQueryData<{
          pages: Array<{ items: Array<{ id: ThreadId }> }>;
        }>(activeList)
        ?.pages[0]?.items.map(({ id }) => id),
    ).toEqual([threadId]);
    expect(
      queryClient.getQueryData(threadKeys.detail(userId, threadId)),
    ).toBeUndefined();

    response.resolve(
      Response.json({
        status: "success",
        data: thread,
        initialSubmission: { submissionId: "submission-initial" },
      }),
    );
    await admission;
  });

  it("shares intent-preloaded project data with warm route loading", async () => {
    const network = new FrontendNetworkHarness(() =>
      Response.json({ status: "success", data: project }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/"] }),
    );

    await router.preloadRoute({
      to: "/projects/$projectId",
      params: { projectId },
    });
    const cached = queryClient.getQueryData(
      projectKeys.detail(userId, projectId),
    );
    await router.navigate({
      to: "/projects/$projectId",
      params: { projectId },
    });

    expect(network.getCount(`/v1/projects/${projectId}`)).toBe(1);
    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(cached);
    expect(cached).toMatchObject({ id: projectId, name: project.name });
    expect(
      router.state.matches.find(
        (match) => match.routeId === "/_product/projects/$projectId",
      )?.loaderData,
    ).toBeUndefined();
    expect(router.state.status).toBe("idle");
  });

  it("preloads New Thread settings for the modal at router intent", async () => {
    const network = new FrontendNetworkHarness(() =>
      Response.json({ status: "success", data: { activeScope: "personal" } }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/"] }),
    );

    await router.preloadRoute({ to: "/new", search: { project: undefined } });
    const cached = queryClient.getQueryData(
      settingsKeys.context(userId, { scope: "personal" }),
    );
    await router.navigate({ to: "/new", search: { project: undefined } });

    expect(network.getCount("/v1/settings/personal")).toBe(1);
    expect(cached).toBeDefined();
    expect(router.state.status).toBe("idle");
  });

  it("lets the New Thread modal render a settings preload failure", async () => {
    const network = new FrontendNetworkHarness(() =>
      Response.json(
        { status: "error", error: { code: "SETTINGS_UNAVAILABLE" } },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/"] }),
    );

    await router.navigate({ to: "/new", search: { project: undefined } });

    expect(router.state.location.pathname).toBe("/new");
    expect(router.state.status).toBe("idle");
    expect(
      queryClient.getQueryState(
        settingsKeys.context(userId, { scope: "personal" }),
      )?.status,
    ).toBe("error");
  });

  it("promotes a fresh listed project for detail/settings route reuse", async () => {
    const network = new FrontendNetworkHarness(() => {
      throw new Error("A listed project must not be fetched again.");
    });
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    queryClient.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [project] }],
      pageParams: [undefined],
    });

    await ensureProjectRouteData({ queryClient, userId }, projectId);

    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBe(project);
    expect(network.getCount(`/v1/projects/${projectId}`)).toBe(0);
  });

  it("reuses fresh project route data across back/forward navigation", async () => {
    const network = new FrontendNetworkHarness(() =>
      Response.json({ status: "success", data: project }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/"] }),
    );
    const unsubscribe = router.history.subscribe(({ action }) => {
      void router.load({ action });
    });

    await router.load();
    await router.navigate({
      to: "/projects/$projectId",
      params: { projectId },
    });
    await router.navigate({ to: "/" });
    router.history.back();
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${projectId}`),
    );
    router.history.forward();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    router.history.back();
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${projectId}`),
    );

    expect(network.getCount(`/v1/projects/${projectId}`)).toBe(1);
    unsubscribe();
  });

  it("navigates a newly created thread from seeded thread/project data without GETs", async () => {
    const network = new FrontendNetworkHarness((request) => {
      if (request.method === "POST" && request.url === "/v1/threads")
        return Response.json({ status: "success", data: thread });
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    vi.stubGlobal("fetch", network.fetch);
    const queryClient = createQueryClient();
    queryClient.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [project] }],
      pageParams: [undefined],
    });
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, createThreadMutationOptions(queryClient, userId));
    const router = createAppRouter(
      { queryClient, userId },
      createMemoryHistory({ initialEntries: ["/new"] }),
    );

    await mutation.execute({
      project,
      title: "Test thread",
      selection: {
        kind: "mode" as const,
        profileId: "default" as const,
        mode: "medium" as const,
      },
    });
    await router.navigate({
      to: "/threads/$threadId",
      params: { threadId },
    });
    const [cachedThread, cachedProject] = await Promise.all([
      queryClient.fetchQuery(threadQueryOptions(userId, threadId)),
      queryClient.fetchQuery(projectQueryOptions(userId, projectId)),
    ]);

    expect(cachedThread).toBe(
      queryClient.getQueryData(threadKeys.detail(userId, threadId)),
    );
    expect(cachedProject).toBe(project);
    expect(network.getCount(`/v1/threads/${threadId}`)).toBe(0);
    expect(network.getCount(`/v1/projects/${projectId}`)).toBe(0);
    expect(network.requests).toEqual([{ method: "POST", url: "/v1/threads" }]);
  });

  it("propagates critical query errors without creating loader-owned data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          Response.json(
            { status: "error", error: { code: "NOT_FOUND" } },
            { status: 404 },
          ),
        ),
    );
    const queryClient = createQueryClient();

    await expect(
      ensureProjectRouteData({ queryClient, userId }, projectId),
    ).rejects.toBeInstanceOf(ApiError);
    expect(
      queryClient.getQueryData(projectKeys.detail(userId, projectId)),
    ).toBeUndefined();
  });
});
