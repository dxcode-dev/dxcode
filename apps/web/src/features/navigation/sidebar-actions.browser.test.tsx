// The sidebar's Thread actions against a fake dx server, through the real
// shell, sidebar, menus, providers, router, and toasts:
// - a sidebar row shows the title the title bar shows (#1135);
// - Pin moves the row at once and a failed pin says so (#1140);
// - Ctrl+B reopens the sidebar on the open Thread's row (#1143);
// - Copy and Unarchive behave alike from both menus (#1145);
// - a Thread list that fails to load offers Retry (#1181).

import type { ProjectData, ThreadDetailData } from "@dx/api";
import {
  defaultThreadModelSelection,
  type ProjectId,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => false,
}));
// The synced layout has its own tests; this file keeps it in the browser.
vi.mock("./sidebar-layout.js", async (importOriginal) => {
  const layout = await importOriginal<typeof import("./sidebar-layout.js")>();
  return {
    ...layout,
    useSyncedSidebarLayout: () => layout.useLocalSidebarLayout(),
  };
});

import { AuthContext } from "../../shared/auth/auth-context.js";
import { CommandProvider } from "../../shared/commands/command-provider.js";
import { createCommandRegistry } from "../../shared/commands/command-registry.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { Toaster } from "../../shared/ui/sonner.js";
import { projectKeys } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ThreadArchiveProvider } from "../threads/thread-archive.js";
import { ThreadEditingProvider } from "../threads/thread-editing.js";
import { ThreadMenu } from "../threads/thread-menu.js";
import { threadKeys, threadQueryOptions } from "../threads/thread-queries.js";
import { ThreadSnoozeProvider } from "../threads/thread-snooze.js";
import { ProductShell } from "./product-shell.js";
// The app's stylesheet places the hover preview beside the sidebar. Without
// it the preview renders in flow over the rows, and once its 500 ms intent
// fires before a click (a slow run), it covers the Pin button the click waits
// for until the test times out.
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_sidebar_actions" as UserId;
const projectId = "prj_00000000-0000-4000-8000-0000000000a1" as ProjectId;
const project = {
  id: projectId,
  name: "Sidebar project",
} as unknown as ProjectData;
const id = (n: number) =>
  `thr_00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}` as ThreadId;
const ALPHA = id(1);
const BETA = id(2);
const GAMMA = id(3);
const CHILD = id(4);

interface ServerThread {
  id: ThreadId;
  title: string;
  titlePending?: true;
  lifecycleState: "active" | "archived";
  /** Minutes before 12:00; orders the list, newest first. */
  age: number;
  pinnedAt?: string;
  parentThreadId?: ThreadId;
}

const at = (minutesAgo: number) =>
  new Date(
    Date.parse("2026-10-31T12:00:00.000Z") - minutesAgo * 60_000,
  ).toISOString();

const encode = (thread: ServerThread, threads: ReadonlyArray<ServerThread>) => {
  const children = threads.filter(
    (child) =>
      child.parentThreadId === thread.id &&
      child.lifecycleState === thread.lifecycleState,
  ).length;
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.titlePending ? { titlePending: true } : {}),
    projectId,
    visibility: "private",
    createdAt: at(thread.age),
    updatedAt: at(thread.age),
    lastActivityAt: at(thread.age),
    activityStatus: "idle",
    lifecycleState: thread.lifecycleState,
    ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
    ...(thread.parentThreadId === undefined
      ? {}
      : { parentThreadId: thread.parentThreadId }),
    ...(children === 0 ? {} : { childCount: children }),
    agentUrl: `/v1/agents/dx/${thread.id}`,
    mode: "high",
  };
};

const detail = (thread: ServerThread) => {
  const { mode: _mode, childCount: _count, ...row } = encode(thread, []);
  return {
    ...row,
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
  };
};

const failure = () =>
  Response.json(
    {
      status: "error",
      data: { code: "INTERNAL", message: "Simulated failure" },
    },
    { status: 500 },
  );

/**
 * dx's Thread routes over in-memory Threads. `hold` keeps a route's
 * response until released; `fail` answers it with a 500.
 */
const fakeServer = (threads: ServerThread[]) => {
  const state = {
    threads,
    fail: new Set<"list" | "pin">(),
    held: [] as Array<() => void>,
    hold: new Set<"pin" | "detail">(),
  };
  const later = (route: "pin" | "detail", respond: () => Response) =>
    state.hold.has(route)
      ? new Promise<Response>((resolve) =>
          state.held.push(() => resolve(respond())),
        )
      : respond();
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), "https://dx.test");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/threads" && method === "GET") {
      const lifecycle = url.searchParams.get("lifecycleState");
      if (lifecycle === "active" && state.fail.has("list")) return failure();
      const roots = state.threads
        .filter(
          (thread) =>
            thread.lifecycleState === lifecycle &&
            thread.parentThreadId === undefined,
        )
        .sort(
          (a, b) =>
            (b.pinnedAt === undefined ? 0 : Date.parse(b.pinnedAt)) -
              (a.pinnedAt === undefined ? 0 : Date.parse(a.pinnedAt)) ||
            a.age - b.age,
        );
      const children = state.threads.filter(
        (thread) =>
          thread.lifecycleState === lifecycle &&
          roots.some(({ id }) => id === thread.parentThreadId),
      );
      return Response.json({
        status: "success",
        data: {
          items: roots.map((thread) => encode(thread, state.threads)),
          ...(children.length === 0
            ? {}
            : {
                children: children.map((thread) =>
                  encode(thread, state.threads),
                ),
              }),
        },
      });
    }
    const action = /^\/v1\/threads\/([^/]+)(?:\/(\w+))?$/u.exec(path);
    const thread = state.threads.find(({ id }) => id === action?.[1]);
    if (thread !== undefined && action?.[2] === "pin" && method === "PATCH")
      return later("pin", () => {
        if (state.fail.has("pin")) return failure();
        const { pinned } = JSON.parse(String(init?.body)) as {
          pinned: boolean;
        };
        if (pinned) thread.pinnedAt = "2026-10-31T12:30:00.000Z";
        else delete thread.pinnedAt;
        return Response.json({
          status: "success",
          data: encode(thread, []),
        });
      });
    if (
      thread !== undefined &&
      action?.[2] === "archive" &&
      method === "PATCH"
    ) {
      const body = JSON.parse(String(init?.body)) as {
        archived: boolean;
        includeChildren?: boolean;
      };
      const from = body.archived ? "active" : "archived";
      const to = body.archived ? "archived" : "active";
      const changed = body.includeChildren
        ? state.threads.filter(
            (child) =>
              child.parentThreadId === thread.id &&
              child.lifecycleState === from,
          )
        : [];
      thread.lifecycleState = to;
      for (const child of changed) child.lifecycleState = to;
      return Response.json({
        status: "success",
        data: encode(thread, []),
        ...(body.includeChildren
          ? { changedChildThreadIds: changed.map(({ id }) => id) }
          : {}),
      });
    }
    if (thread !== undefined && action?.[2] === undefined && method === "GET")
      return later("detail", () =>
        Response.json({ status: "success", data: detail(thread) }),
      );
    // Account, inboxes, previews, and the rest stay loading.
    return new Promise<Response>(() => {});
  });
  return {
    ...state,
    release: () => {
      for (const resolve of state.held.splice(0)) resolve();
    },
  };
};

/** The Thread page's title bar: its detail query, title, and More Actions. */
function ThreadPageStub() {
  const { threadId } = useParams({ strict: false }) as {
    readonly threadId: ThreadId;
  };
  const query = useQuery(threadQueryOptions(userId, threadId));
  if (query.data === undefined) return null;
  return (
    <header>
      <h1 data-testid="title-bar">
        {query.data.titlePending === true ? "…" : query.data.title}
      </h1>
      <ThreadMenu
        thread={query.data as ThreadDetailData}
        transcript={() => ({}) as never}
      />
    </header>
  );
}

let root: Root | undefined;

afterEach(async () => {
  // Sonner keeps toasts across mounts and replays them to the next Toaster,
  // where they would satisfy the next test's wait for its own toast.
  await React.act(() => toast.dismiss());
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (
  threads: ServerThread[],
  path = `/threads/${BETA}`,
  configure?: (server: ReturnType<typeof fakeServer>) => void,
) => {
  const server = fakeServer(threads);
  configure?.(server);
  const client = createQueryClient();
  client.setQueryData(projectKeys.lists(userId), {
    pages: [{ items: [project] }],
    pageParams: [undefined],
  });
  client.setQueryData(personalAccountQueryOptions(userId).queryKey, {
    displayName: "Test",
    email: "t@dx.test",
  } as never);
  client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    activeScope: "personal",
  } as never);
  client.setQueryData(threadKeys.shared(userId), []);
  const rootRoute = createRootRoute({
    component: () => (
      <CommandProvider registry={createCommandRegistry({ platform: "linux" })}>
        <ThreadArchiveProvider>
          <ThreadSnoozeProvider>
            <ThreadEditingProvider>
              <ProductShell />
            </ThreadEditingProvider>
          </ThreadSnoozeProvider>
        </ThreadArchiveProvider>
      </CommandProvider>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: ThreadPageStub,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1440px";
  container.style.height = "900px";
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
          <Toaster />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { server, client, router };
};

const settle = (ms = 100) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Waits for a condition the UI reaches on its own, such as a refetch. */
const until = async (check: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle(50);
  }
};

const rowTitles = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".product-sidebar [data-thread-section] .thread-row",
    ),
  ].map((row) =>
    row.querySelector(".thread-title-pending") === null
      ? (row.textContent ?? "").trim()
      : "•••",
  );

const sectionTitles = (section: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `.product-sidebar [data-thread-section="${section}"] .thread-row`,
    ),
  ].map((element) => (element.textContent ?? "").trim());

const row = (title: string) => {
  const found = [
    ...document.querySelectorAll<HTMLElement>(".product-sidebar .thread-row"),
  ].find((element) => element.textContent?.includes(title));
  if (found === undefined) throw new Error(`Expected the ${title} row.`);
  return found;
};

const toasts = () =>
  [...document.querySelectorAll("[data-sonner-toast]")].map(
    (toast) => toast.textContent ?? "",
  );

const openContextMenu = async (element: HTMLElement) => {
  const bounds = element.getBoundingClientRect();
  await React.act(() =>
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 10,
        clientY: bounds.top + 5,
      }),
    ),
  );
  await settle();
};

const menuItem = (selector: string, text: string) => {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (item) => item.textContent?.trim().startsWith(text),
  );
  if (found === undefined) throw new Error(`Expected the ${text} item.`);
  return found;
};

const hover = async (element: HTMLElement) => {
  await userEvent.hover(element);
  await settle();
};

const threeThreads = (): ServerThread[] => [
  { id: ALPHA, title: "Alpha", lifecycleState: "active", age: 1 },
  { id: BETA, title: "Beta", lifecycleState: "active", age: 2 },
  { id: GAMMA, title: "Gamma", lifecycleState: "active", age: 3 },
];

it("#1140: moves a pinned row at once, and puts it back with a toast when the pin fails", async () => {
  const { server } = await mount(threeThreads());
  expect(rowTitles()).toEqual(["Alpha", "Beta", "Gamma"]);

  // The server holds the pin; the row moves before it answers.
  server.hold.add("pin");
  const gamma = row("Gamma").closest<HTMLElement>(".thread-row-shell");
  if (gamma === null) throw new Error("Expected Gamma's row.");
  await hover(gamma);
  // Click it directly, as below: Playwright waits for the hover-revealed
  // button to become visible, and on one 4-core Orb it never did, so the
  // release gate timed out after 15 s while the test passed elsewhere.
  await React.act(() =>
    gamma.querySelector<HTMLElement>('[aria-label="Pin thread"]')?.click(),
  );
  await settle();
  expect(rowTitles()).toEqual(["Gamma", "Alpha", "Beta"]);
  server.release();
  await settle(300);
  expect(rowTitles()).toEqual(["Gamma", "Alpha", "Beta"]);

  // A refused pin returns the row and says so.
  server.hold.delete("pin");
  server.fail.add("pin");
  const beta = row("Beta").closest<HTMLElement>(".thread-row-shell");
  if (beta === null) throw new Error("Expected Beta's row.");
  await hover(beta);
  // Playwright's locator for this button never settles; click it directly.
  await React.act(() =>
    beta.querySelector<HTMLElement>('[aria-label="Pin thread"]')?.click(),
  );
  await until(() =>
    toasts().some((text) => text.includes("could not be pinned")),
  );
  expect(rowTitles()).toEqual(["Gamma", "Alpha", "Beta"]);
});

it("#1143: Ctrl+B reopens the sidebar on the open Thread's row", async () => {
  await mount(threeThreads(), `/threads/${GAMMA}`);
  // Opening a Thread with the mouse marks its row for the arrow keys.
  row("Alpha").focus();
  row("Alpha").blur();

  await userEvent.keyboard("{Control>}b{/Control}");
  await settle(400);
  expect(document.querySelector('[aria-label="Open sidebar"]')).not.toBeNull();
  (document.activeElement as HTMLElement | null)?.blur();

  await userEvent.keyboard("{Control>}b{/Control}");
  await settle(400);
  expect(document.activeElement?.textContent).toContain("Gamma");
});

it("#1145: Copy from the sidebar confirms with a toast, as the header menu does", async () => {
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  await mount(threeThreads(), `/threads/${BETA}`);

  await openContextMenu(row("Beta"));
  await userEvent.hover(menuItem(".thread-context-item", "Copy"));
  await settle(200);
  await userEvent.click(menuItem(".thread-context-item", "Thread URL"));
  await until(() =>
    toasts().some((text) => text.includes("Thread URL copied")),
  );
  const sidebarUrl = writeText.mock.calls.at(-1)?.[0];
  expect(sidebarUrl).toMatch(new RegExp(`/threads/${BETA}$`, "u"));
});

it("#1145: Copy from the header menu confirms with the same toast", async () => {
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  await mount(threeThreads(), `/threads/${BETA}`);
  await until(
    () => document.querySelector('[aria-label="More Actions"]') !== null,
  );
  await userEvent.click(
    document.querySelector<HTMLElement>(
      '[aria-label="More Actions"]',
    ) as HTMLElement,
  );
  await settle();
  await userEvent.click(menuItem(".thread-menu-item", "Copy Thread URL"));
  await until(() =>
    toasts().some((text) => text.includes("Thread URL copied")),
  );
  expect(writeText.mock.calls.at(-1)?.[0]).toMatch(
    new RegExp(`/threads/${BETA}$`, "u"),
  );
});

it("#1145: Unarchive on an archived parent offers its children, as Archive does", async () => {
  const { server } = await mount(
    [
      { id: ALPHA, title: "Alpha", lifecycleState: "active", age: 1 },
      { id: BETA, title: "Parent", lifecycleState: "archived", age: 2 },
      {
        id: CHILD,
        title: "Child",
        lifecycleState: "archived",
        age: 3,
        parentThreadId: BETA,
      },
    ],
    `/threads/${ALPHA}`,
  );
  await userEvent.click(
    menuItem(".product-sidebar .thread-group-heading", "Archived"),
  );
  await until(() => rowTitles().includes("Parent"));

  await openContextMenu(row("Parent"));
  await userEvent.hover(menuItem(".thread-context-item", "Unarchive"));
  await settle(200);
  await userEvent.click(menuItem(".thread-context-item", "All 2 Threads"));
  await until(
    () =>
      sectionTitles(projectId).includes("Parent") &&
      !sectionTitles("archived").includes("Child"),
  );

  expect(
    server.threads.map(({ title, lifecycleState }) => [title, lifecycleState]),
  ).toEqual([
    ["Alpha", "active"],
    ["Parent", "active"],
    ["Child", "active"],
  ]);
});

it("#1181: a Thread list that fails to load says so and retries", async () => {
  const { server } = await mount(threeThreads(), `/threads/${BETA}`, (server) =>
    server.fail.add("list"),
  );
  // The first load and the client's one retry both fail.
  await until(
    () =>
      document
        .querySelector(".product-sidebar [role='alert']")
        ?.textContent?.includes("Could not load threads") === true,
    6_000,
  );
  expect(document.querySelector(".product-sidebar")?.textContent).not.toContain(
    "Request failed.",
  );

  server.fail.delete("list");
  await userEvent.click(menuItem(".product-sidebar button", "Retry"));
  await until(() => rowTitles().join() === "Alpha,Beta,Gamma");
  expect(document.querySelector(".product-sidebar [role='alert']")).toBeNull();
});

it("#1135: a sidebar row shows the title once the title bar does", async () => {
  const threads: ServerThread[] = [
    {
      id: ALPHA,
      title: "Fallback title",
      titlePending: true,
      lifecycleState: "active",
      age: 1,
    },
    { id: BETA, title: "Beta", lifecycleState: "active", age: 2 },
  ];
  const { server } = await mount(threads, `/threads/${ALPHA}`);
  await until(
    () => document.querySelector('[data-testid="title-bar"]') !== null,
  );
  expect(rowTitles()).toEqual(["•••", "Beta"]);

  // The title agent settles the title. No list refetch or realtime hint
  // reaches this browser, as when one is lost; the title bar's detail
  // poll still sees it.
  const alpha = server.threads[0] as ServerThread;
  delete alpha.titlePending;
  alpha.title = "Generated title";
  await until(
    () =>
      document.querySelector('[data-testid="title-bar"]')?.textContent ===
      "Generated title",
    8_000,
  );
  await settle(100);
  expect(rowTitles()).toEqual(["Generated title", "Beta"]);
});
