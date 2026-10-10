// @vitest-environment happy-dom

import type {
  PersonalAccountData,
  ProjectData,
  ThreadDetailData,
} from "@dx/api";
import {
  defaultThreadModelSelection,
  type PageCursor,
  UserId,
} from "@dx/domain";
import {
  focusManager,
  InfiniteQueryObserver,
  isCancelledError,
  onlineManager,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectKeys,
  projectsQueryOptions,
} from "../features/projects/project-queries.js";
import {
  personalAccountQueryOptions,
  updatePersonalAccountMutationOptions,
} from "../features/settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../features/settings/settings-context-queries.js";
import { cacheCreatedThread } from "../features/threads/thread-mutations.js";
import {
  threadKeys,
  threadsQueryOptions,
} from "../features/threads/thread-queries.js";
import { listProjects } from "../shared/api/client.js";
import { AuthContext } from "../shared/auth/auth-context.js";
import { createQueryClient } from "../shared/query/query-client.js";
import { FrontendNetworkHarness } from "./frontend-network-harness.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const runtime = vi.hoisted(() => ({
  mobile: false,
  client: { kind: "flue-client", send: vi.fn() },
  createFlueClient: vi.fn(),
  useFlueAgent: vi.fn(),
  outlet: vi.fn(),
}));

vi.mock("../shared/use-mobile.js", () => ({
  useMobile: () => runtime.mobile,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => runtime.outlet(),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string }) => unknown;
  }) => select({ pathname: "/threads/thread-1" }),
}));

vi.mock("@flue/sdk", () => ({
  createFlueClient: runtime.createFlueClient,
}));

vi.mock("@flue/react", () => ({
  useFlueAgent: runtime.useFlueAgent,
}));

vi.mock("../features/threads/agent-panel.js", () => ({
  AgentPanel: () => <div data-testid="agent-panel" />,
}));

vi.mock("../features/navigation/app-sidebar.js", () => ({
  AppSidebar: ({
    collapseLabel,
    onCollapse,
  }: {
    collapseLabel: string;
    onCollapse: () => void;
  }) => (
    <nav data-testid="app-sidebar">
      <button type="button" aria-label={collapseLabel} onClick={onCollapse} />
    </nav>
  ),
}));

import { ProductShell } from "../features/navigation/product-shell.js";
import { ThreadSession } from "../features/threads/thread-workspace.js";

const act = React.act;

const emptyProjectPage = () =>
  Response.json({ status: "success", data: { items: [] } });

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const projectQuery = () => projectsQueryOptions(userId);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
  onlineManager.setOnline(true);
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  runtime.mobile = false;
  runtime.createFlueClient.mockReset();
  runtime.useFlueAgent.mockReset();
});

describe("frontend dx request regression harness", () => {
  it("coalesces initial, intent-preload, and duplicate-consumer semantic reads", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();

    await Promise.all([
      client.fetchInfiniteQuery(projectQuery()),
      client.fetchInfiniteQuery(projectQuery()),
      client.fetchInfiniteQuery(projectQuery()),
    ]);

    expect(network.getCount("/v1/projects?limit=100")).toBe(1);
    expect(() => network.assertNoDuplicateSemanticGets()).not.toThrow();
  });

  it("reuses Query intent preloading when navigation mounts the consumer", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();

    await client.prefetchInfiniteQuery(projectQuery());
    await client.fetchInfiniteQuery(projectQuery());

    expect(network.getCount("/v1/projects?limit=100")).toBe(1);
  });

  it("reuses fresh data during back/forward navigation", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();

    await client.fetchInfiniteQuery(projectQuery());
    vi.advanceTimersByTime(29_999);
    await client.fetchInfiniteQuery(projectQuery());

    expect(network.getCount("/v1/projects?limit=100")).toBe(1);
    expect(() => network.assertNoDuplicateSemanticGets()).not.toThrow();
  });

  it("refetches an observed query on focus after it becomes stale", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();
    client.mount();
    const observer = new InfiniteQueryObserver(client, projectQuery());
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch();
    vi.advanceTimersByTime(30_001);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => {
      expect(network.getCount("/v1/projects?limit=100")).toBe(2);
    });

    unsubscribe();
    client.unmount();
  });

  it("propagates Query cancellation to the HTTP request", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const client = createQueryClient();
    const pending = client.fetchInfiniteQuery(projectQuery());
    void pending.catch(() => undefined);

    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await client.cancelQueries({ queryKey: projectKeys.lists(userId) });

    expect(requestSignal?.aborted).toBe(true);
    expect(
      isCancelledError(await pending.catch((error: unknown) => error)),
    ).toBe(true);
  });

  it("makes a created thread visible in detail and sidebar caches without a GET", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();
    const thread = {
      id: "thread-created",
      title: "Created thread",
      projectId: "project-1",
      visibility: "private",
      agentUrl: "/v1/threads/thread-created/agent",
      executionWorkspace: { ready: true, preparationStatus: null },
      agentInitialization: { selection: defaultThreadModelSelection() },
    } as unknown as ThreadDetailData;
    const allThreads = threadsQueryOptions(userId);
    const projectThreads = threadsQueryOptions(
      userId,
      thread.projectId as ProjectData["id"],
    );
    for (const options of [allThreads, projectThreads])
      client.setQueryData(options.queryKey, {
        pages: [{ items: [] }],
        pageParams: [undefined],
      });

    await cacheCreatedThread(client, userId, thread);

    expect(client.getQueryData(threadKeys.detail(userId, thread.id))).toBe(
      thread,
    );
    for (const options of [allThreads, projectThreads])
      expect(
        client.getQueryData<{ pages: Array<{ items: ThreadDetailData[] }> }>(
          options.queryKey,
        )?.pages[0]?.items,
      ).toEqual([{ ...thread, mode: "medium" }]);
    expect(network.requests).toHaveLength(0);
  });

  it("uses one settings GET and writes an authoritative mutation response without refetching", async () => {
    const initial = {
      displayName: "Test User",
      username: "test-user",
      email: "test@example.com",
      emailVerified: true,
      identityAuthority: "local-password",
      threadCount: 2,
      appearance: "dark",
      palette: "daydream",
      terminalTheme: "github",
    };
    const updated = { ...initial, displayName: "Updated User" };
    const network = new FrontendNetworkHarness(({ method }) =>
      Response.json({
        status: "success",
        data: method === "PATCH" ? updated : initial,
      }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();
    const options = personalAccountQueryOptions(userId);

    await client.fetchQuery(options);
    const mutation = client
      .getMutationCache()
      .build(client, updatePersonalAccountMutationOptions(client, userId));
    await mutation.execute({
      displayName: updated.displayName,
      username: updated.username,
    });

    expect(network.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "/v1/settings/personal/account"],
      ["PATCH", "/v1/settings/personal/account"],
    ]);
    expect(network.getCount("/v1/settings/personal/account")).toBe(1);
    expect(client.getQueryData(options.queryKey)).toEqual(updated);
  });

  it("records pagination as one GET per distinct semantic page", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);

    await listProjects();
    await listProjects("next-page" as PageCursor);

    expect(network.requests.map(({ url }) => url)).toEqual([
      "/v1/projects?limit=100",
      "/v1/projects?cursor=next-page&limit=100",
    ]);
    expect(() => network.assertNoDuplicateSemanticGets()).not.toThrow();
  });

  it("keeps a one-minute polling fallback at an exact two-GET minute budget", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();
    client.mount();
    const primary = new InfiniteQueryObserver(
      client,
      threadsQueryOptions(userId),
    );
    const duplicateConsumer = new InfiniteQueryObserver(
      client,
      threadsQueryOptions(userId),
    );
    const unsubscribePrimary = primary.subscribe(() => undefined);

    await primary.refetch();
    const unsubscribeDuplicate = duplicateConsumer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(network.getCount("/v1/threads?limit=100")).toBe(2);
    unsubscribeDuplicate();
    unsubscribePrimary();
    client.unmount();
  });

  it("reconciles the thread index immediately on focus and reconnect", async () => {
    const network = new FrontendNetworkHarness(emptyProjectPage);
    vi.stubGlobal("fetch", network.fetch);
    const client = createQueryClient();
    client.mount();
    const observer = new InfiniteQueryObserver(
      client,
      threadsQueryOptions(userId),
    );
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() =>
      expect(network.getCount("/v1/threads?limit=100")).toBe(2),
    );
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await vi.waitFor(() =>
      expect(network.getCount("/v1/threads?limit=100")).toBe(3),
    );

    unsubscribe();
    client.unmount();
  });
});

describe("ProductShell route ownership across the mobile breakpoint", () => {
  let container: HTMLDivElement;
  let root: Root;
  const client = createQueryClient();
  const auth = {
    identity: { id: userId, name: "Test User", email: "test@example.com" },
    logout: vi.fn(),
  };
  const shell = () => (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={auth}>
        <ProductShell />
      </AuthContext.Provider>
    </QueryClientProvider>
  );

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client.clear();
    client.setQueryData(projectKeys.lists(userId), {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
    client.setQueryData(threadKeys.list(userId), {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
    client.setQueryData(threadKeys.list(userId, undefined, "active"), {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
    client.setQueryData(threadKeys.list(userId, undefined, "archived"), {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
    client.setQueryData(personalAccountQueryOptions(userId).queryKey, {
      displayName: "Test User",
      email: "test@example.com",
    } as PersonalAccountData);
    client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
      activeScope: "personal",
    });
    client.setQueryData(threadKeys.shared(userId), []);
    runtime.createFlueClient.mockReturnValue(runtime.client);
    runtime.useFlueAgent.mockReturnValue({});
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it("keeps one routed Flue session and performs no duplicate dx GET while crossing", async () => {
    const thread = {
      id: "thread-1",
      title: "Test thread",
      visibility: "private",
      agentUrl: "/v1/threads/thread-1/agent",
      executionWorkspace: { ready: true, preparationStatus: null },
      agentInitialization: { selection: defaultThreadModelSelection() },
    } as unknown as ThreadDetailData;
    const changesUrl = `/v1/threads/${thread.id}/changes?range=all`;
    const network = new FrontendNetworkHarness((request) => {
      if (request.method === "GET" && request.url === changesUrl)
        return Response.json({
          status: "success",
          data: { kind: "missing" },
        });
      throw new Error("Breakpoint crossing performed an unexpected request.");
    });
    vi.stubGlobal("fetch", network.fetch);
    const project = { name: "Project" } as ProjectData;
    const routeIdentities = new Set<symbol>();
    const ThreadRoute = () => {
      const [identity] = React.useState(() => Symbol("thread-route"));
      routeIdentities.add(identity);
      return <ThreadSession thread={thread} project={project} />;
    };
    runtime.outlet.mockImplementation(() => <ThreadRoute />);

    runtime.mobile = false;
    await act(() => root.render(shell()));
    await vi.waitFor(() => expect(network.getCount(changesUrl)).toBe(1));
    expect(container.querySelector(".thread-region")).not.toBeNull();
    const navigationPanel = container.querySelector<HTMLElement>(
      "#product-navigation",
    );
    expect(navigationPanel).not.toBeNull();
    expect(navigationPanel?.hidden).toBe(false);
    expect(
      container.querySelector('[aria-label="Resize navigation"]'),
    ).not.toBeNull();

    runtime.mobile = true;
    await act(() => root.render(shell()));

    expect(routeIdentities.size).toBe(1);
    expect(runtime.createFlueClient).toHaveBeenCalledTimes(1);
    expect(runtime.useFlueAgent).toHaveBeenCalled();
    expect(
      runtime.useFlueAgent.mock.calls.every(
        ([options]) =>
          options.client === runtime.client && options.live === "sse",
      ),
    ).toBe(true);
    expect(network.requests).toHaveLength(1);
    expect(container.querySelector(".mobile-thread-region")).not.toBeNull();
    expect(
      container.querySelector(".product-panel-group[data-mobile]"),
    ).not.toBeNull();
    expect(navigationPanel?.hidden).toBe(true);
    const mobileSidebarTrigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open sidebar"]',
    );
    expect(mobileSidebarTrigger).not.toBeNull();
    mobileSidebarTrigger?.focus();
    await act(() => mobileSidebarTrigger?.click());
    expect(document.querySelector(".mobile-sidebar-drawer")).not.toBeNull();
    expect(
      document.querySelector('[data-testid="app-sidebar"]'),
    ).not.toBeNull();
    await act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
    );
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".mobile-sidebar-drawer")).toBeNull();
    expect(document.activeElement).toBe(mobileSidebarTrigger);

    await act(() => mobileSidebarTrigger?.click());
    await act(() =>
      document
        .querySelector(".mobile-sidebar-scrim")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".mobile-sidebar-drawer")).toBeNull();

    await act(() => mobileSidebarTrigger?.click());
    const closeSidebar = document.querySelector<HTMLButtonElement>(
      '[aria-label="Close sidebar"]',
    );
    expect(closeSidebar).not.toBeNull();
    await act(() => closeSidebar?.click());
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".mobile-sidebar-drawer")).toBeNull();

    runtime.mobile = false;
    await act(() => root.render(shell()));
    expect(routeIdentities.size).toBe(1);
    expect(runtime.createFlueClient).toHaveBeenCalledTimes(1);
    expect(network.requests).toHaveLength(1);
    expect(container.querySelector(".thread-region")).not.toBeNull();
    expect(
      container.querySelector(".product-panel-group[data-mobile]"),
    ).toBeNull();
    expect(navigationPanel?.hidden).toBe(false);
    expect(
      container.querySelector('[aria-label="Resize navigation"]'),
    ).not.toBeNull();
  });
});
