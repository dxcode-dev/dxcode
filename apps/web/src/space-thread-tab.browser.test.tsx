// A thread a Space started, open in its tab: the real Thread page
// (`ThreadWorkspace`, its pane tree, agent card, and composer) rendered
// through the real Space page and route, as the Thread route composes them.
// Flue is a stand-in with an empty conversation; the dx server answers the
// Space's reads and nothing else.
//
// Ways it could go wrong: the Thread page draws its own title bar under the
// tab strip; the agent pane keeps its own one-tab strip, so two tab rows
// stack; the agent card does not meet the thread's tab, sits off its left
// edge, or takes another colour than the tab; the card's corners or the
// shell show through; the composer is missing; the Thread's Views button is
// missing from the tab, or a second view loses its pane strip. Screenshots go to
// apps/web/.cache/spaces-v2-ui/.

import type { ThreadDetailData } from "@dx/api";
import {
  defaultThreadModelSelection,
  type ProjectId,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

const snapshot = vi.hoisted(() => ({
  error: undefined,
  failedSends: [],
  historyReady: true,
  hasMore: false,
  messages: [],
  settlements: [],
  status: "ready",
  abort: () => undefined,
  refresh: () => undefined,
  resendPrompt: () => undefined,
  resume: () => undefined,
  retrySend: () => undefined,
  sendMessage: () => undefined,
  loadOlder: () => undefined,
}));

vi.mock("@flue/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flue/react")>()),
  useFlueAgent: () => snapshot,
  createFlueAgentSession: () => ({
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
    // A settled, empty conversation, as Flue reports one.
    getSnapshot: () => snapshot,
    sendMessage: vi.fn(),
    resume: vi.fn(),
    abort: vi.fn(),
    retrySend: vi.fn(),
    resendPrompt: vi.fn(),
    refresh: vi.fn(),
    loadOlder: vi.fn(),
  }),
}));
vi.mock("@flue/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flue/sdk")>()),
  createFlueClient: () => ({ send: vi.fn() }),
}));

import { projectKeys } from "./features/projects/project-queries.js";
import { defaultPaneLayout } from "./features/threads/panes/pane-layout.js";
import { paneLayoutKeys } from "./features/threads/panes/pane-layout-queries.js";
import { threadKeys } from "./features/threads/thread-queries.js";
import { ThreadWorkspace } from "./features/threads/thread-workspace.js";
import { AuthContext } from "./shared/auth/auth-context.js";
import { createQueryClient } from "./shared/query/query-client.js";
import { SpaceRoute } from "./space-route.js";
import "./styles.css";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = "../.cache/spaces-v2-ui";
const viewer = "usr_tab_viewer" as UserId;
const SPACE = "thr_00000000-0000-4000-8000-0000000000f1" as ThreadId;
const CHILD = "thr_00000000-0000-4000-8000-0000000000f2" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000f3" as ProjectId;
const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const childThread = {
  id: CHILD,
  title: "Top-level repo folders",
  projectId: PROJECT,
  parentThreadId: SPACE,
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  agentUrl: `/v1/agents/dx/${CHILD}`,
  agentInitialization: {
    selection: defaultThreadModelSelection(),
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;

const serve = () => {
  const ok = (data: unknown) => Response.json({ status: "success", data });
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (path === `/v1/spaces/${SPACE}`)
      return ok({
        space: {
          threadId: SPACE,
          name: "dx parity probe",
          goal: "Small research tasks on the dx repository.",
          color: "red",
          projectId: PROJECT,
          projectName: "dx",
          sharing: "private",
          ownerUserId: viewer,
          members: [{ userId: viewer, name: "Rhea Banerjee" }],
          joined: true,
          access: "owner",
          lifecycleState: "active",
          statusLine: null,
          waitingOnInput: false,
          createdAt: at(30),
          lastActivityAt: at(1),
        },
      });
    if (path === `/v1/spaces/${SPACE}/threads`)
      return ok({
        items: [
          {
            ...childThread,
            createdAt: at(10),
            updatedAt: at(2),
            lastActivityAt: at(2),
            mode: "medium",
            requestedBy: null,
            statusLine: "Listing folders",
            state: "idle",
            shippedAt: null,
            archivedAt: null,
          },
        ],
      });
    if (path === `/v1/spaces/${SPACE}/posts`)
      return ok({
        items: [
          {
            id: `pst_${"1".padStart(26, "0")}`,
            author: { kind: "agent", name: "dx" },
            text: `Started it.\n\n[Top-level repo folders](/threads/${CHILD})`,
            createdAt: at(9),
            revisionCount: 0,
            reactions: [],
            comments: { count: 0, commenters: [] },
          },
        ],
      });
    if (path === `/v1/spaces/${SPACE}/catch-up`) return ok({ catchUp: null });
    return new Promise<Response>(() => {});
  });
};

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.resolvedAppearance;
  delete document.documentElement.dataset.palette;
  vi.unstubAllGlobals();
});

const settle = (ms = 50) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 6_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle();
  }
};

const mount = async () => {
  serve();
  await page.viewport(1440, 900);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
  } as never);
  queryClient.setQueryData(threadKeys.detail(viewer, CHILD), childThread);
  queryClient.setQueryData(projectKeys.detail(viewer, PROJECT), {
    id: PROJECT,
    name: "dx",
    revision: 1,
  } as never);
  queryClient.setQueryData(
    paneLayoutKeys.layout(viewer, CHILD),
    defaultPaneLayout(),
  );
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    validateSearch: (search: Record<string, unknown>) =>
      typeof search.thread === "string" ? { thread: search.thread } : {},
    component: () => (
      <main
        className="product-shell-content"
        style={{ position: "fixed", inset: 0, display: "flex" }}
      >
        <SpaceRoute
          renderThread={(props) => <ThreadWorkspace {...props} />}
          dictation={undefined}
        />
      </main>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([thread])]),
    history: createMemoryHistory({
      initialEntries: [`/threads/${SPACE}?thread=${CHILD}`],
    }),
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Rhea Banerjee", email: "r@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  return queryClient;
};

const q = (selector: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(selector);
const box = (element: Element | null) =>
  (element as Element).getBoundingClientRect();

it("shows the real Thread page in the thread's tab, its agent card right under the tab", async () => {
  await mount();
  const pane = () => q(".space-thread-pane");
  await until(
    () =>
      pane() !== null &&
      q(".thread-pane", pane() as HTMLElement) !== null &&
      q("[aria-label='Message']", pane() as HTMLElement) !== null,
  );
  const thread = pane() as HTMLElement;
  // The tab strip stands for the Thread's title bar; no title bar of its own.
  expect(q(".thread-title-bar", thread)).toBeNull();
  const strip = q(".space-tab-strip", thread) as HTMLElement;
  const tab = q(".space-thread-tab", strip) as HTMLElement;
  expect(tab.textContent).toContain("Top-level repo folders");
  expect(q(".space-tab-mode", strip)?.textContent).toBe("medium");
  // The Thread's own More Actions sits in the tab.
  expect(
    q(".space-tab-menu [aria-label='More Actions']", tab) ??
      q(".space-tab-menu button", tab),
  ).not.toBeNull();
  // With Agent its only view, the pane's own strip gives way to the tab.
  const paneStrip = q(".thread-pane > .pane-strip-drop", thread);
  expect(
    paneStrip === null || getComputedStyle(paneStrip).display === "none",
  ).toBe(true);
  // The agent card meets the tab: right under it, from its left edge, in
  // the tab's colour, with the composer inside.
  const card = q(".thread-pane > .pane-body", thread) as HTMLElement;
  expect(Math.abs(box(card).top - box(strip).bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(box(card).left - box(tab).left)).toBeLessThanOrEqual(1);
  expect(getComputedStyle(card).backgroundColor).toBe(
    getComputedStyle(tab).backgroundColor,
  );
  expect(getComputedStyle(card).borderTopLeftRadius).toBe("0px");
  expect(getComputedStyle(card).borderTopRightRadius).not.toBe("0px");
  // It ends where the Space chat's surface ends.
  expect(
    Math.abs(
      box(card).bottom - box(q(".space-chat-pane .space-pane-body")).bottom,
    ),
  ).toBeLessThanOrEqual(1);
  expect(q("[aria-label='Message']", card)).not.toBeNull();
  // Side by side with the Space chat, whose tab sits on the same line.
  const chatTab = q(".space-chat-pane .space-tab") as HTMLElement;
  expect(Math.abs(box(chatTab).top - box(tab).top)).toBeLessThanOrEqual(1);
  await settle(300);
  await page.screenshot({ path: `${SHOTS}/space-real-thread-tab-1440.png` });

  // Views opens another of the Thread's views; with two, the pane's own
  // strip comes back so each can be chosen.
  await userEvent.click(q("[aria-label='Views']", strip) as HTMLElement);
  await until(() => document.querySelector("[role='menuitem']") !== null);
  await userEvent.click(
    [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
      (item) => item.textContent?.includes("Artifacts"),
    ) as HTMLElement,
  );
  await until(
    () => thread.querySelectorAll(".thread-pane .pane-tab").length >= 2,
  );
  // Whether it opens beside the agent or as its second tab, every pane
  // shows its strip again.
  const strips = [
    ...thread.querySelectorAll<HTMLElement>(".thread-pane > .pane-strip-drop"),
  ];
  expect(strips.length).toBeGreaterThan(0);
  for (const each of strips)
    expect(getComputedStyle(each).display).not.toBe("none");
  await settle(300);
  await page.screenshot({
    path: `${SHOTS}/space-real-thread-tab-views-1440.png`,
  });
});
