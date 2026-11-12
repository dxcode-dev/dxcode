// A normal Thread, a Space's own chat, and a thread the Space started, each
// through the real Thread page and Space page as the Thread route composes
// them, at 1440x900 and 390x844. Each must say what it runs on (here Claude
// Code, Opus 5.5 at high effort) in its bar or its More Actions, and its
// owner must reach its cost (Cost & Usage) from More Actions.
//
// Ways it could go wrong: the Space's chat shows no model and no cost; a
// child's tab shows the raw model ID or a stale list `mode` instead of what
// the Thread page shows; a child's More Actions lacks the Project, Share…,
// or the model on a phone; the Space's menu cannot be reached on a phone
// without opening Space Details; Cost & Usage does not open from a Space.
// Screenshots go to apps/web/.cache/header-parity/.

import type { ThreadDetailData } from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
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
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";
import { defaultPaneLayout } from "./features/threads/panes/pane-layout.js";
import { paneLayoutKeys } from "./features/threads/panes/pane-layout-queries.js";
import { threadKeys } from "./features/threads/thread-queries.js";

import { AuthContext } from "./shared/auth/auth-context.js";
import { createQueryClient } from "./shared/query/query-client.js";
import { ThreadRoute } from "./thread-route.js";
import "./styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = `../.cache/header-parity/${import.meta.env.VITE_PARITY_PHASE ?? "after"}`;
const viewer = "usr_parity_viewer" as UserId;
const NORMAL = "thr_00000000-0000-4000-8000-0000000000a1" as ThreadId;
const SPACE = "thr_00000000-0000-4000-8000-0000000000a2" as ThreadId;
const CHILD = "thr_00000000-0000-4000-8000-0000000000a3" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000a4" as ProjectId;
const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const CLAUDE_CODE = {
  kind: "model",
  model: "claude-code/claude-opus-5-5",
  thinking: "high",
} as const;

const detail = (
  id: ThreadId,
  title: string,
  extra: Partial<Record<keyof ThreadDetailData, unknown>> = {},
) =>
  ({
    id,
    title,
    projectId: PROJECT,
    visibility: "private",
    lifecycleState: "active",
    activityStatus: "idle",
    createdAt: at(30),
    updatedAt: at(1),
    lastActivityAt: at(1),
    agentUrl: `/v1/agents/dx/${id}`,
    agentInitialization: { selection: CLAUDE_CODE, skills: [] },
    executionWorkspace: { ready: true, preparationStatus: null },
    ...extra,
  }) as unknown as ThreadDetailData;

const threads = {
  [NORMAL]: detail(NORMAL, "Normal thread"),
  // A Space's own Thread runs without an Orb.
  [SPACE]: detail(SPACE, "Parity Space", {
    kind: "space",
    executionWorkspace: { ready: false, preparationStatus: null },
  }),
  [CHILD]: detail(CHILD, "Child thread", { parentThreadId: SPACE }),
};

const usage = {
  claudeCode: true,
  totalMicros: 1_230_000,
  byokListPriceMicros: 0,
  creditsMicros: 0,
  listPriceMicros: 1_230_000,
  tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 },
  requests: 3,
  routes: [],
  models: [],
  orb: null,
  context: { available: false, reason: "claude-code" },
};

/** A schedule, a CI and a PR-comments subscription, a pull request, CI. */
const automations = {
  schedule: {
    title: "Nightly check",
    prompt: "Check the build.",
    label: "Daily, 9:00 AM",
    rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timeZone: "UTC",
    runMode: "existing",
    enabled: true,
    nextRunAt: at(-600),
  },
  githubSubscriptions: [
    {
      id: `ghs_${"a".repeat(32)}`,
      title: "CI on abc1234",
      repository: "acme/app",
      filterKind: "ci",
      target: "CI on abc1234",
      url: "https://github.com/acme/app/commit/abc1234",
      destination: "this-thread",
      automatic: true,
      enabled: true,
      state: "active",
      createdAt: at(20),
    },
    {
      id: `ghs_${"b".repeat(32)}`,
      title: "PR #12 comments",
      repository: "acme/app",
      filterKind: "pr-comments",
      target: "comments on #12",
      url: "https://github.com/acme/app/pull/12",
      destination: "this-thread",
      automatic: true,
      enabled: true,
      state: "active",
      createdAt: at(20),
    },
  ],
  issues: [],
  pullRequests: [
    {
      repository: "acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      state: "open",
      title: "Fix the header",
    },
  ],
  ciRuns: [
    {
      repository: "acme/app",
      sha: "abc1234def5678",
      branch: "fix-header",
      result: "passed",
      url: "https://github.com/acme/app/commit/abc1234",
      checks: [{ name: "build", result: "success" }],
      at: at(5),
    },
  ],
};

const serve = () => {
  const ok = (data: unknown) => Response.json({ status: "success", data });
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (/^\/v1\/threads\/[^/]+\/usage$/.test(path)) return ok(usage);
    if (/^\/v1\/threads\/[^/]+\/automations$/.test(path))
      return ok(automations);
    if (path === `/v1/spaces/${SPACE}`)
      return ok({
        space: {
          threadId: SPACE,
          name: "Parity Space",
          goal: "Compare headers.",
          color: "blue",
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
            ...threads[CHILD],
            // The list's mode is the raw model ID for a pinned model.
            mode: CLAUDE_CODE.model,
            requestedBy: null,
            statusLine: null,
            state: "idle",
            shippedAt: null,
            archivedAt: null,
          },
        ],
      });
    if (path === `/v1/spaces/${SPACE}/posts`) return ok({ items: [] });
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

const mount = async (url: string, width: number, height: number) => {
  serve();
  await page.viewport(width, height);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
  } as never);
  for (const thread of Object.values(threads)) {
    queryClient.setQueryData(threadKeys.detail(viewer, thread.id), thread);
    queryClient.setQueryData(
      paneLayoutKeys.layout(viewer, thread.id),
      defaultPaneLayout(),
    );
  }
  queryClient.setQueryData(projectKeys.detail(viewer, PROJECT), {
    id: PROJECT,
    name: "dx",
    revision: 1,
  } as never);
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const ThreadPage = () => {
    const { threadId } = thread.useParams();
    return (
      <main
        className="product-shell-content"
        style={{ position: "fixed", inset: 0, display: "flex" }}
      >
        {/* The real Thread route: a Space's page for the Space, with
            what the route hands it, else the Thread page. */}
        <ThreadRoute key={threadId} />
      </main>
    );
  };
  const thread = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    validateSearch: (search: Record<string, unknown>) =>
      typeof search.thread === "string" ? { thread: search.thread } : {},
    component: ThreadPage,
  });
  const projects = createRoute({
    getParentRoute: () => product,
    path: "/projects/$projectId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([thread, projects])]),
    history: createMemoryHistory({ initialEntries: [url] }),
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
};

const visible = (element: Element) => {
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
};

/** The first visible element matching a selector whose label matches. */
const control = (scope: ParentNode, selector: string, label: RegExp) =>
  [...scope.querySelectorAll<HTMLElement>(selector)].find(
    (element) =>
      label.test(
        element.getAttribute("aria-label") ?? element.textContent ?? "",
      ) && visible(element),
  );

const menuText = () =>
  [...document.querySelectorAll(".thread-menu-popup")]
    .map((popup) => popup.textContent)
    .join(" | ");

type Surface = "normal" | "space" | "child";
const URLS: Record<Surface, string> = {
  normal: `/threads/${NORMAL}`,
  space: `/threads/${SPACE}`,
  child: `/threads/${SPACE}?thread=${CHILD}`,
};

/** The bar that stands for the surface's title bar. */
const barOf = (surface: Surface) =>
  surface === "normal"
    ? document.querySelector<HTMLElement>(".thread-title-bar")
    : surface === "space"
      ? document.querySelector<HTMLElement>(".space-chat-pane .space-tab-strip")
      : document.querySelector<HTMLElement>(
          ".space-thread-pane .space-tab-strip",
        );

/** The surface's More Actions in its bar, or for a Space, its menu. */
const menuButtonOf = (surface: Surface) => {
  const bar = barOf(surface);
  if (bar === null) return undefined;
  return (
    control(bar, "button", /^More Actions$/) ??
    (surface === "space"
      ? control(document, "button", /^Space Actions$/)
      : undefined)
  );
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS)
  for (const surface of ["normal", "space", "child"] as const)
    it(`${surface} on ${viewport.name}: says what it runs on and reaches Cost & Usage`, async () => {
      await mount(URLS[surface], viewport.width, viewport.height);
      await until(() => barOf(surface) !== null);
      if (surface === "child")
        await until(
          () =>
            document.querySelector(
              ".space-thread-pane .space-tab-menu button",
            ) !== null,
        );
      await settle(400);
      const shot = `${SHOTS}/${viewport.name}-${surface}`;
      await page.screenshot({ path: `${shot}-bar.png` });
      const bar = barOf(surface) as HTMLElement;
      const barText = bar.textContent ?? "";

      // The menu: from the bar itself, as on a normal Thread.
      const button = menuButtonOf(surface);
      expect.soft(button, "More Actions in the bar").toBeDefined();
      if (button === undefined) return;
      await userEvent.click(button);
      await until(() => document.querySelector(".thread-menu-popup") !== null);
      // The cost row reads usage once the menu opens.
      await until(() => /\$1\.23/.test(menuText()), 4_000).catch(() => {});
      await settle(200);
      await page.screenshot({ path: `${shot}-menu.png` });
      const text = menuText();

      // What it runs on, in the bar on a desktop or in More Actions.
      const runsOn = `${barText} ${text}`;
      expect.soft(runsOn, "says Claude Code").toMatch(/claude code/i);
      expect.soft(runsOn, "names the model").toMatch(/Opus 5\.5/);
      expect.soft(runsOn, "no raw model ID").not.toMatch(/claude-code\//);
      // The owner's cost, which opens Cost & Usage.
      expect.soft(text, "shows the cost").toMatch(/\$1\.23/);
      expect
        .soft(text, "Claude Code costs note")
        .toMatch(/Claude Code Costs Not Tracked/);
      // A Thread (not the Space chat, which has its Project in Space
      // Details) lists its Project, in its bar or menu, and Share….
      if (surface !== "space") {
        expect.soft(`${barText} ${text}`, "shows the Project").toMatch(/dx/);
        if (viewport.name === "phone" || surface === "child")
          expect.soft(text, "offers Share…").toMatch(/Share…/);
      }
      const cost = [
        ...document.querySelectorAll<HTMLElement>(".thread-menu-item"),
      ].find((item) => /\$1\.23/.test(item.textContent ?? ""));
      if (cost === undefined) return;
      await userEvent.click(cost);
      await until(
        () => document.querySelector("[role='dialog']") !== null,
        4_000,
      ).catch(() => {});
      await settle(300);
      expect
        .soft(
          document.querySelector("[role='dialog']")?.textContent ?? "",
          "Cost & Usage opens",
        )
        .toMatch(/Cost|Usage/);
      await page.screenshot({ path: `${shot}-usage.png` });
    });

/** The automations' chips shown outside any menu: PR, CI, listeners. */
const automationChips = () =>
  [...document.querySelectorAll<HTMLElement>(".automation-chip")]
    .filter(visible)
    .map((chip) => chip.getAttribute("aria-label") ?? "");

for (const viewport of VIEWPORTS)
  for (const surface of ["normal", "space", "child"] as const)
    it(`${surface} on ${viewport.name}: shows its pull requests, CI, schedule, and GitHub subscriptions`, async () => {
      await mount(URLS[surface], viewport.width, viewport.height);
      await until(() => barOf(surface) !== null);
      if (surface === "child")
        await until(
          () =>
            document.querySelector(
              ".space-thread-pane .space-tab-menu button",
            ) !== null,
        );
      await settle(600);
      const shot = `${SHOTS}/${viewport.name}-${surface}-automations`;
      await page.screenshot({ path: `${shot}-bar.png` });
      if (viewport.name === "desktop") {
        // In the bar, as chips that open their lists.
        const chips = automationChips().join(" | ");
        expect.soft(chips, "pull request chip").toMatch(/pull request/);
        expect.soft(chips, "CI chip").toMatch(/Passed on abc1234|abc1234/);
        expect
          .soft(chips, "listeners chip")
          .toMatch(/subscriptions.*Scheduled|Scheduled/);
        const listeners = [
          ...document.querySelectorAll<HTMLElement>(".automation-chip"),
        ].find(
          (chip) =>
            visible(chip) &&
            /Scheduled/.test(chip.getAttribute("aria-label") ?? ""),
        );
        if (listeners === undefined) return;
        await userEvent.click(listeners);
        await settle(400);
        const panel = document.body.textContent ?? "";
        expect.soft(panel, "lists the schedule").toMatch(/Daily, 9:00 AM/);
        expect
          .soft(panel, "lists the CI subscription")
          .toMatch(/CI on abc1234/);
        expect
          .soft(panel, "lists the PR comments subscription")
          .toMatch(/comments on #12/);
        await page.screenshot({ path: `${shot}-open.png` });
        return;
      }
      // On a phone, each sits in the bar while it fits, else in More
      // Actions, as a normal Thread's narrow bar does.
      const inBar = automationChips().join(" | ");
      const button = menuButtonOf(surface);
      expect.soft(button, "More Actions in the bar").toBeDefined();
      if (button === undefined) return;
      await userEvent.click(button);
      await until(() => document.querySelector(".thread-menu-popup") !== null);
      await settle(300);
      await page.screenshot({ path: `${shot}-menu.png` });
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          ".thread-menu-popup .thread-menu-item",
        ),
      ].map((item) => item.textContent?.trim() ?? "");
      const reachable = (chip: RegExp, item: string) =>
        chip.test(inBar) || items.includes(item);
      expect
        .soft(reachable(/pull request/, "Pull requests"), "pull requests")
        .toBe(true);
      expect.soft(reachable(/abc1234/, "CI"), "CI").toBe(true);
      expect
        .soft(
          reachable(/Scheduled/, "Schedule and GitHub events"),
          "schedule and GitHub events",
        )
        .toBe(true);
      const entry = [
        ...document.querySelectorAll<HTMLElement>(
          ".thread-menu-popup .thread-menu-item",
        ),
      ].find((item) =>
        /Schedule and GitHub events/.test(item.textContent ?? ""),
      );
      if (entry !== undefined) await userEvent.click(entry);
      else {
        await userEvent.keyboard("{Escape}");
        await settle(200);
        const chip = [
          ...document.querySelectorAll<HTMLElement>(".automation-chip"),
        ].find(
          (each) =>
            visible(each) &&
            /Scheduled/.test(each.getAttribute("aria-label") ?? ""),
        );
        if (chip === undefined) return;
        await userEvent.click(chip);
      }
      await settle(500);
      const sheet = document.body.textContent ?? "";
      expect.soft(sheet, "lists the schedule").toMatch(/Daily, 9:00 AM/);
      expect
        .soft(sheet, "lists the PR comments subscription")
        .toMatch(/comments on #12/);
      await page.screenshot({ path: `${shot}-open.png` });
    });
