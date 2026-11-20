// Archiving Threads one after another, quickly, through the real shell,
// sidebar, menus, toasts, and realtime row patches, against a fake dx server
// whose archive is slow the way Core's is (it stops the agent and the Orb
// before it answers). Every DOM change is checked: a Thread the person
// archived never shows in the active sidebar again, and one they restored
// never leaves it, whatever reads land in between.

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
vi.mock("./sidebar-layout.js", async (importOriginal) => {
  const layout = await importOriginal<typeof import("./sidebar-layout.js")>();
  return {
    ...layout,
    useSyncedSidebarLayout: () => layout.useLocalSidebarLayout(),
  };
});

import { getThreadListItem } from "../../shared/api/client.js";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { CommandProvider } from "../../shared/commands/command-provider.js";
import { createCommandRegistry } from "../../shared/commands/command-registry.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { useThreadArchive } from "../../shared/thread-archive.js";
import { Toaster } from "../../shared/ui/sonner.js";
import { projectKeys } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { SidebarSpacesSection } from "../spaces/sidebar-spaces-section.js";
import { ThreadArchiveProvider } from "../threads/thread-archive.js";
import { ThreadEditingProvider } from "../threads/thread-editing.js";
import { ThreadMenu } from "../threads/thread-menu.js";
import { threadKeys, threadQueryOptions } from "../threads/thread-queries.js";
import { ThreadListRows } from "../threads/thread-row-queries.js";
import { ThreadSnoozeProvider } from "../threads/thread-snooze.js";
import { ProductShell } from "./product-shell.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_rapid_archive" as UserId;
const projectId = "prj_00000000-0000-4000-8000-0000000000b1" as ProjectId;
const project = { id: projectId, name: "Rapid" } as unknown as ProjectData;
const id = (n: number) =>
  `thr_00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}` as ThreadId;

interface ServerThread {
  id: ThreadId;
  title: string;
  lifecycleState: "active" | "archived";
  /** Minutes since its last activity; orders the list, newest first. */
  age: number;
  pinnedAt?: string;
  /** A Space's own Thread: listed under Spaces while active. */
  space?: true;
}

const startedAt = Date.now();
const at = (minutesAgo: number) =>
  new Date(startedAt - minutesAgo * 60_000).toISOString();

const encode = (thread: ServerThread) => ({
  id: thread.id,
  title: thread.title,
  projectId,
  visibility: "private",
  createdAt: at(thread.age),
  updatedAt: at(thread.age),
  lastActivityAt: at(thread.age),
  activityStatus: "idle",
  lifecycleState: thread.lifecycleState,
  ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
  agentUrl: `/v1/agents/dx/${thread.id}`,
  mode: "high",
});

const detail = (thread: ServerThread) => {
  const { mode: _mode, ...row } = encode(thread);
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

const spaceData = (thread: ServerThread) => ({
  threadId: thread.id,
  name: thread.title,
  goal: null,
  color: "green",
  projectId,
  projectName: "Rapid",
  sharing: "private",
  ownerUserId: userId,
  members: [{ userId, name: "Test" }],
  joined: true,
  access: "owner",
  lifecycleState: thread.lifecycleState,
  statusLine: null,
  waitingOnInput: false,
  createdAt: at(thread.age),
  lastActivityAt: at(thread.age),
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Core's Thread routes over in-memory Threads, each answer after a delay.
 * An archive writes the Thread a quarter of the way through, publishes its
 * realtime hint, and answers at the end, as Core does after stopping the
 * agent and Orb. Every request is logged with its start and end.
 */
const fakeServer = (threads: ServerThread[]) => {
  const state = {
    threads,
    latency: { list: 120, archive: 900, pin: 300, update: 300, row: 80 },
    /** Threads whose archive or restore the server refuses. */
    refuse: new Set<ThreadId>(),
    log: [] as string[],
    /** Archives answer once this settles. */
    answered: Promise.resolve() as Promise<void>,
    /** Called when an archive is written: the realtime hint. */
    written: (_threadId: ThreadId): void => undefined,
  };
  const t0 = performance.now();
  const stamp = () => String(Math.round(performance.now() - t0)).padStart(5);
  const name = (threadId: string | undefined) =>
    state.threads.find(({ id }) => id === threadId)?.title ?? threadId;
  const ok = (data: unknown) => Response.json({ status: "success", data });
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), "https://dx.test");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/threads" && method === "GET") {
      const lifecycle = url.searchParams.get("lifecycleState");
      state.log.push(`${stamp()} list ${lifecycle} start`);
      await delay(state.latency.list);
      const items = state.threads
        .filter(
          (thread) =>
            thread.lifecycleState === lifecycle &&
            (thread.space !== true || lifecycle === "archived"),
        )
        .sort(
          (a, b) =>
            (b.pinnedAt === undefined ? 0 : Date.parse(b.pinnedAt)) -
              (a.pinnedAt === undefined ? 0 : Date.parse(a.pinnedAt)) ||
            a.age - b.age,
        );
      state.log.push(
        `${stamp()} list ${lifecycle} end [${items.map(({ title }) => title).join(",")}]`,
      );
      return ok({ items: items.map(encode) });
    }
    if (path === "/v1/spaces" && method === "GET") {
      await delay(state.latency.list);
      return ok({
        items: state.threads
          .filter(
            (thread) =>
              thread.space === true && thread.lifecycleState === "active",
          )
          .map(spaceData),
      });
    }
    const action = /^\/v1\/threads\/([^/]+)(?:\/([\w-]+))?$/u.exec(path);
    const thread = state.threads.find(({ id }) => id === action?.[1]);
    if (thread === undefined) return new Promise<Response>(() => {});
    const route = action?.[2];
    if (route === "archive" && method === "PATCH") {
      const { archived } = JSON.parse(String(init?.body)) as {
        archived: boolean;
      };
      const verb = archived ? "archive" : "unarchive";
      state.log.push(`${stamp()} ${verb} ${name(thread.id)} start`);
      await delay(state.latency.archive / 4);
      if (state.refuse.has(thread.id)) {
        await delay((state.latency.archive * 3) / 4);
        state.log.push(`${stamp()} ${verb} ${name(thread.id)} refused`);
        return Response.json(
          {
            status: "error",
            data: { code: "INTERNAL", message: "Simulated failure" },
          },
          { status: 500 },
        );
      }
      thread.lifecycleState = archived ? "archived" : "active";
      if (archived) delete thread.pinnedAt;
      state.log.push(`${stamp()} ${verb} ${name(thread.id)} written`);
      state.written(thread.id);
      await delay((state.latency.archive * 3) / 4);
      await state.answered;
      state.log.push(`${stamp()} ${verb} ${name(thread.id)} end`);
      return ok(encode(thread));
    }
    if (route === "pin" && method === "PATCH") {
      const { pinned } = JSON.parse(String(init?.body)) as { pinned: boolean };
      state.log.push(`${stamp()} pin ${name(thread.id)} start`);
      await delay(state.latency.pin);
      if (pinned) thread.pinnedAt = at(-30);
      else delete thread.pinnedAt;
      state.log.push(`${stamp()} pin ${name(thread.id)} end`);
      return ok(encode(thread));
    }
    if (route === undefined && method === "PATCH") {
      const { title } = JSON.parse(String(init?.body)) as { title?: string };
      state.log.push(`${stamp()} rename ${name(thread.id)} start`);
      await delay(state.latency.update);
      if (title !== undefined) thread.title = title;
      state.log.push(`${stamp()} rename ${name(thread.id)} end`);
      return ok(encode(thread));
    }
    if (route === "list-item" && method === "GET") {
      await delay(state.latency.row);
      return ok(encode(thread));
    }
    if (route === undefined && method === "GET") return ok(detail(thread));
    return new Promise<Response>(() => {});
  });
  return state;
};

function ThreadPageStub() {
  const { threadId } = useParams({ strict: false }) as {
    readonly threadId: ThreadId;
  };
  const query = useQuery(threadQueryOptions(userId, threadId));
  if (query.data === undefined) return null;
  return (
    <header>
      <h1 data-testid="title-bar">{query.data.title}</h1>
      <ThreadMenu
        thread={query.data as ThreadDetailData}
        transcript={() => ({}) as never}
      />
    </header>
  );
}

let root: Root | undefined;
let stopRealtime: (() => void) | undefined;

afterEach(async () => {
  stopRealtime?.();
  stopRealtime = undefined;
  await React.act(() => toast.dismiss());
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms = 100) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 8_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting. Sidebar: [${activeTitles().join(",")}]; toasts: [${toasts().join(" | ")}]`,
      );
    await settle(50);
  }
};

/** Titles of the rows in every sidebar section but Archived. */
const activeTitles = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".product-sidebar [data-thread-section]:not([data-thread-section='archived']) .thread-row",
    ),
  ].map((element) => (element.textContent ?? "").trim());

const sectionTitles = (section: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `.product-sidebar [data-thread-section="${section}"] .thread-row`,
    ),
  ].map((element) => (element.textContent ?? "").trim());

const rowShell = (title: string) => {
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      ".product-sidebar .thread-row-shell",
    ),
  ].find(
    (element) =>
      element.querySelector(".thread-row")?.textContent?.trim() === title,
  );
  if (found === undefined) throw new Error(`Expected the ${title} row.`);
  return found;
};

const menuItem = (selector: string, text: string) => {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (item) => item.textContent?.trim().startsWith(text),
  );
  if (found === undefined) throw new Error(`Expected the ${text} item.`);
  return found;
};

/** Clicks a row's hover action, as a person does a few hundred ms apart. */
const rowAction = async (title: string, label: string) => {
  const shell = rowShell(title);
  await userEvent.hover(shell);
  await React.act(() =>
    shell.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click(),
  );
  await settle(150);
};

const toasts = () =>
  [...document.querySelectorAll("[data-sonner-toast]")].map(
    (element) => element.textContent ?? "",
  );

/**
 * Watches every DOM change for the rule: each title in `archived` is absent
 * from the active sidebar, each in `active` is present. Returns what broke
 * it, with the time and what the sidebar showed.
 */
const watchSidebar = () => {
  const archived = new Set<string>();
  const active = new Set<string>();
  const broken: string[] = [];
  const t0 = performance.now();
  const check = () => {
    const shown = activeTitles();
    for (const title of archived)
      if (shown.includes(title))
        broken.push(
          `${Math.round(performance.now() - t0)}ms: archived ${title} shows in [${shown.join(",")}]`,
        );
    for (const title of active)
      if (!shown.includes(title))
        broken.push(
          `${Math.round(performance.now() - t0)}ms: active ${title} missing from [${shown.join(",")}]`,
        );
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return {
    archived,
    active,
    broken,
    stop: () => observer.disconnect(),
  };
};

/** The Space page's Archive menu item: the same controller call. */
function ArchiveSpaceButton({ threadId }: { readonly threadId: ThreadId }) {
  const archive = useThreadArchive();
  return (
    <button
      type="button"
      data-testid="archive-space"
      onClick={() => archive?.setArchived(threadId, true)}
    >
      Archive Space
    </button>
  );
}

const spaceTitles = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".product-sidebar section[aria-label='Spaces'] a.thread-row",
    ),
  ].map((element) => (element.textContent ?? "").trim());

const mount = async (
  threads: ServerThread[],
  path: string,
  spaceThreadId?: ThreadId,
) => {
  const server = fakeServer(threads);
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
  // Realtime: Core publishes a hint for each Thread it writes, and the
  // sidebar reads the row and patches it in, as `RealtimeClient` does.
  const rows = new ThreadListRows(client, userId, (threadId) =>
    getThreadListItem(threadId),
  );
  stopRealtime = () => rows.stop();
  server.written = (threadId) => rows.threadChanged(threadId);
  const rootRoute = createRootRoute({
    component: () => (
      <CommandProvider registry={createCommandRegistry({ platform: "linux" })}>
        <ThreadArchiveProvider>
          <ThreadSnoozeProvider>
            <ThreadEditingProvider>
              <ProductShell
                spacesSection={(onNavigate) => (
                  <SidebarSpacesSection onNavigate={onNavigate} />
                )}
              />
              {spaceThreadId === undefined ? null : (
                <ArchiveSpaceButton threadId={spaceThreadId} />
              )}
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
  await until(() => activeTitles().length > 0);
  await settle(200);
  return { server, client };
};

const fiveThreads = (): ServerThread[] =>
  ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((title, index) => ({
    id: id(index + 1),
    title,
    lifecycleState: "active",
    age: index + 1,
  }));

const report = (
  server: ReturnType<typeof fakeServer>,
  watch: ReturnType<typeof watchSidebar>,
) =>
  `sidebar broke its rule:\n${watch.broken.slice(0, 8).join("\n")}\n\nrequests:\n${server.log.join("\n")}`;

it("archived Threads stay gone while later archives are in flight", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(5)}`);
  const watch = watchSidebar();
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) {
    await rowAction(title, "Archive thread");
    watch.archived.add(title);
  }
  watch.active.add("Epsilon");
  await until(() =>
    server.threads.every(
      (thread) =>
        thread.title === "Epsilon" || thread.lifecycleState === "archived",
    ),
  );
  // Every answer, refetch, and realtime patch has landed.
  await settle(1_500);
  watch.stop();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(activeTitles()).toEqual(["Epsilon"]);
});

it("every archive request leaves at once, without waiting for the one before it", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(5)}`);
  // No archive answers until all four were chosen: a request queued behind
  // another's answer (its Orb stopping) never starts, and a reload then
  // would lose it.
  let release: () => void = () => undefined;
  server.answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"])
    await rowAction(title, "Archive thread");
  await settle(300);
  const started = server.log.filter((line) =>
    /archive \w+ start$/u.test(line),
  ).length;
  release();
  expect(started, server.log.join("\n")).toBe(4);
  await until(() =>
    server.threads
      .filter(({ title }) => title !== "Epsilon")
      .every(({ lifecycleState }) => lifecycleState === "archived"),
  );
});

it("Archive Inactive and a single archive in quick turns keep every Thread archived", async () => {
  const inactive = 73 * 60;
  const { server } = await mount(
    [
      { id: id(1), title: "Alpha", lifecycleState: "active", age: 1 },
      { id: id(2), title: "Beta", lifecycleState: "active", age: 2 },
      { id: id(3), title: "Old one", lifecycleState: "active", age: inactive },
      {
        id: id(4),
        title: "Old two",
        lifecycleState: "active",
        age: inactive + 1,
      },
      {
        id: id(5),
        title: "Old three",
        lifecycleState: "active",
        age: inactive + 2,
      },
    ],
    `/threads/${id(2)}`,
  );
  // Inactive starts collapsed; open it so its rows can be watched.
  const inactiveHeading = menuItem(
    ".product-sidebar .thread-group-heading",
    "Inactive",
  );
  if (inactiveHeading.dataset.collapsed !== undefined)
    await userEvent.click(inactiveHeading);
  await until(() => activeTitles().includes("Old one"));
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await React.act(() =>
    document
      .querySelector<HTMLElement>('[aria-label="Archive inactive threads"]')
      ?.click(),
  );
  await settle(150);
  for (const title of ["Old one", "Old two", "Old three"])
    watch.archived.add(title);
  watch.active.add("Beta");
  await until(() =>
    server.threads.every(
      (thread) =>
        thread.title === "Beta" || thread.lifecycleState === "archived",
    ),
  );
  await settle(1_500);
  watch.stop();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(activeTitles()).toEqual(["Beta"]);
});

it("Undo restores a Thread at once while other archives are in flight, and it stays", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(5)}`);
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await rowAction("Beta", "Archive thread");
  // Undo Beta's archive before its request answers.
  await React.act(() => menuItem("[data-sonner-toast] button", "Undo").click());
  await settle(50);
  watch.active.add("Beta");
  await rowAction("Gamma", "Archive thread");
  watch.archived.add("Gamma");
  await until(
    () =>
      server.threads.find(({ title }) => title === "Gamma")?.lifecycleState ===
      "archived",
  );
  await settle(2_500);
  watch.stop();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(
    server.threads.map(
      ({ title, lifecycleState }) => `${title}:${lifecycleState}`,
    ),
  ).toEqual([
    "Alpha:archived",
    "Beta:active",
    "Gamma:archived",
    "Delta:active",
    "Epsilon:active",
  ]);
});

it("a refused archive puts only its own Thread back; the others stay archived", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(5)}`);
  server.refuse.add(id(2));
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await rowAction("Beta", "Archive thread");
  await rowAction("Gamma", "Archive thread");
  watch.archived.add("Gamma");
  await until(
    () =>
      document.querySelector("[data-sonner-toast][data-type='error']") !== null,
  );
  // Beta is back from the moment its archive was refused.
  watch.active.add("Beta");
  await until(
    () =>
      server.threads.find(({ title }) => title === "Gamma")?.lifecycleState ===
      "archived",
  );
  await settle(1_500);
  watch.stop();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(activeTitles()).toEqual(["Beta", "Delta", "Epsilon"]);
});

it("a pin and a rename made while archives are in flight keep showing", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(5)}`);
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await rowAction("Delta", "Pin thread");
  // Delta must stay in Pinned from here on.
  const pinnedBroken: string[] = [];
  const pinned = new MutationObserver(() => {
    if (!sectionTitles("pinned").includes("Delta"))
      pinnedBroken.push(`Pinned: [${sectionTitles("pinned").join(",")}]`);
  });
  pinned.observe(document.body, { childList: true, subtree: true });
  await rowAction("Beta", "Archive thread");
  watch.archived.add("Beta");

  // Rename Gamma from its context menu while both archives run.
  const gamma = rowShell("Gamma").querySelector<HTMLElement>(".thread-row");
  if (gamma === null) throw new Error("Expected Gamma's row.");
  const bounds = gamma.getBoundingClientRect();
  await React.act(() =>
    gamma.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 10,
        clientY: bounds.top + 5,
      }),
    ),
  );
  await settle();
  await userEvent.click(menuItem(".dx-menu-item", "Rename"));
  await until(() => document.querySelector("[role='dialog'] input") !== null);
  const input = document.querySelector<HTMLInputElement>(
    "[role='dialog'] input",
  ) as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, "Gamma renamed{Enter}");
  await until(() => activeTitles().includes("Gamma renamed"));
  watch.active.add("Gamma renamed");

  await until(() =>
    server.threads
      .filter(({ title }) => title === "Alpha" || title === "Beta")
      .every(({ lifecycleState }) => lifecycleState === "archived"),
  );
  await settle(2_000);
  watch.stop();
  pinned.disconnect();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(pinnedBroken, server.log.join("\n")).toEqual([]);
  expect(sectionTitles("pinned")).toEqual(["Delta"]);
});

it("archiving from the title bar's menu and the sidebar in quick turns keeps both archived", async () => {
  const { server } = await mount(fiveThreads(), `/threads/${id(3)}`);
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await until(
    () => document.querySelector('[aria-label="More Actions"]') !== null,
  );
  await userEvent.click(
    document.querySelector<HTMLElement>(
      '[aria-label="More Actions"]',
    ) as HTMLElement,
  );
  await settle();
  await userEvent.click(menuItem(".dx-menu-item", "Archive"));
  await settle(150);
  watch.archived.add("Gamma");
  await rowAction("Beta", "Archive thread");
  watch.archived.add("Beta");
  await until(() =>
    server.threads
      .filter(({ title }) => ["Alpha", "Beta", "Gamma"].includes(title))
      .every(({ lifecycleState }) => lifecycleState === "archived"),
  );
  await settle(1_500);
  watch.stop();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(activeTitles()).toEqual(["Delta", "Epsilon"]);
});

it("an archived Space leaves Spaces at once and stays gone while Threads archive after it", async () => {
  const launch = id(9);
  const { server } = await mount(
    [
      ...fiveThreads(),
      {
        id: launch,
        title: "Launch",
        lifecycleState: "active",
        age: 1,
        space: true,
      },
    ],
    `/threads/${id(5)}`,
    launch,
  );
  await until(() => spaceTitles().some((title) => title.includes("Launch")));
  const spaceShown: string[] = [];
  const watchSpaces = new MutationObserver(() => {
    if (spaceTitles().some((title) => title.includes("Launch")))
      spaceShown.push(`Spaces: [${spaceTitles().join(",")}]`);
  });
  await React.act(() =>
    document
      .querySelector<HTMLElement>("[data-testid='archive-space']")
      ?.click(),
  );
  await settle(150);
  expect(spaceTitles()).toEqual([]);
  watchSpaces.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const watch = watchSidebar();
  await rowAction("Alpha", "Archive thread");
  watch.archived.add("Alpha");
  await rowAction("Beta", "Archive thread");
  watch.archived.add("Beta");
  await until(() =>
    server.threads
      .filter(({ title }) => ["Launch", "Alpha", "Beta"].includes(title))
      .every(({ lifecycleState }) => lifecycleState === "archived"),
  );
  await settle(1_500);
  watch.stop();
  watchSpaces.disconnect();
  expect(watch.broken, report(server, watch)).toEqual([]);
  expect(spaceShown, server.log.join("\n")).toEqual([]);
});
