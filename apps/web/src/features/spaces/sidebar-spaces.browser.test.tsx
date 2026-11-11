// The sidebar's Spaces section against a fake dx server, through the real
// shell, sidebar, dialogs, queries, and router.
//
// Ways it could go wrong: the section is missing, above the pinned Threads,
// or below the other Threads, on a computer or in the phone drawer; it
// shows no empty text without Spaces, or no count once it lists some; its
// heading does not collapse the rows; New Space sends the wrong Project,
// sharing, or a blank goal, creates with no name, or does not open the new
// Space; a suggestion does not fill the name, goal, and Project, or stays
// checked once edited; the Project search cannot pick; the new Space never
// lists in the sidebar; Discover lists nothing, shows no empty state, or
// Join neither joins nor opens the Space; a Space without a workspace offers
// workspace sharing.
//
// Screenshots land in apps/web/.cache/spaces-ui/ (ignored by Git).

import type { ProjectData, SpaceData } from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => viewport.mobile,
}));
vi.mock("../navigation/sidebar-layout.js", async (importOriginal) => {
  const layout =
    await importOriginal<typeof import("../navigation/sidebar-layout.js")>();
  return {
    ...layout,
    useSyncedSidebarLayout: () => layout.useLocalSidebarLayout(),
  };
});

import { AuthContext } from "../../shared/auth/auth-context.js";
import { CommandProvider } from "../../shared/commands/command-provider.js";
import { createCommandRegistry } from "../../shared/commands/command-registry.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { ProductShell } from "../navigation/product-shell.js";
import { projectKeys } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ThreadArchiveProvider } from "../threads/thread-archive.js";
import { ThreadEditingProvider } from "../threads/thread-editing.js";
import { threadKeys } from "../threads/thread-queries.js";
import { ThreadSnoozeProvider } from "../threads/thread-snooze.js";
import { SidebarSpacesSection } from "./sidebar-spaces-section.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_spaces_sidebar" as UserId;
const projects = [
  {
    id: "prj_00000000-0000-4000-8000-0000000000b1" as ProjectId,
    name: "Website",
  },
  {
    id: "prj_00000000-0000-4000-8000-0000000000b2" as ProjectId,
    name: "Checkout",
  },
] as unknown as ProjectData[];
const NEW_SPACE = "thr_00000000-0000-4000-8000-0000000000c1" as ThreadId;
const TEAM_SPACE = "thr_00000000-0000-4000-8000-0000000000c2" as ThreadId;
const now = new Date().toISOString();

const space = (
  threadId: ThreadId,
  fields: Partial<SpaceData> & Pick<SpaceData, "name">,
) => ({
  threadId,
  goal: null,
  color: "green",
  projectId: projects[1]?.id,
  projectName: "Checkout",
  sharing: "workspace",
  ownerUserId: userId,
  members: [{ userId, name: "Ada Owner" }],
  joined: true,
  access: "owner",
  lifecycleState: "active",
  statusLine: null,
  waitingOnInput: false,
  createdAt: now,
  lastActivityAt: now,
  ...fields,
});

/** dx's Spaces routes over in-memory Spaces; every other read stays loading. */
const fakeServer = () => {
  const state = {
    joined: [] as Array<ReturnType<typeof space>>,
    discoverable: [
      space(TEAM_SPACE, {
        name: "Payments",
        goal: "Cut refund time in half",
        ownerUserId: "usr_teammate" as UserId,
        members: [{ userId: "usr_teammate" as UserId, name: "Ben" }],
        joined: false,
        access: "contribute",
      }),
    ],
    created: [] as unknown[],
    joins: [] as string[],
    /** Every path the app requested. */
    requests: [] as string[],
    suggestions: [
      {
        name: "Thread Reliability",
        goal: "Improve thread execution, diagnostics, and file transfer reliability.",
        threadCount: 2,
        projectId: projects[1]?.id,
        projectName: "Checkout",
      },
    ] as unknown[],
    /** Active Threads the sidebar lists; `pinned` ones list under Pinned. */
    threads: [] as Array<{ id: ThreadId; title: string; pinned?: true }>,
  };
  const ok = (data: unknown, status = 200) =>
    Response.json({ status: "success", data }, { status });
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), "https://dx.test");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    state.requests.push(path);
    if (path === "/v1/threads" && method === "GET")
      return ok({
        items:
          url.searchParams.get("lifecycleState") === "active"
            ? state.threads.map(({ id, title, pinned }) => ({
                id,
                title,
                projectId: projects[0]?.id,
                visibility: "private",
                createdAt: now,
                updatedAt: now,
                lastActivityAt: now,
                activityStatus: "idle",
                lifecycleState: "active",
                ...(pinned ? { pinnedAt: now } : {}),
                agentUrl: `/v1/agents/dx/${id}`,
                mode: "high",
              }))
            : [],
      });
    if (path === "/v1/spaces/suggestions" && method === "GET")
      return ok({ items: state.suggestions });
    if (path === "/v1/spaces/discover" && url.searchParams.get("q") !== null)
      return ok({
        items: state.discoverable.filter(({ name }) =>
          name
            .toLowerCase()
            .includes((url.searchParams.get("q") ?? "").toLowerCase()),
        ),
      });
    if (path === "/v1/spaces" && method === "GET")
      return ok({ items: state.joined });
    if (path === "/v1/spaces" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      state.created.push(body);
      const created = space(NEW_SPACE, {
        name: body.name ?? "",
        goal: body.goal ?? null,
        projectId: body.projectId as ProjectId,
        sharing: body.sharing as "workspace",
      });
      state.joined.unshift(created);
      return ok({ space: created }, 201);
    }
    if (path === "/v1/spaces/discover" && method === "GET")
      return ok({ items: state.discoverable });
    const join = /^\/v1\/spaces\/([^/]+)\/join$/u.exec(path);
    if (join !== null && method === "POST") {
      const found = state.discoverable.find(
        ({ threadId }) => threadId === join[1],
      );
      if (found === undefined) return new Response(null, { status: 404 });
      state.joins.push(found.threadId);
      state.discoverable = state.discoverable.filter((item) => item !== found);
      const joined = { ...found, joined: true };
      state.joined.push(joined);
      return ok({ space: joined });
    }
    return new Promise<Response>(() => {});
  });
  return state;
};

/** Stands in for the Thread page: which Thread the router opened. */
function ThreadPageStub() {
  const { threadId } = useParams({ strict: false }) as {
    readonly threadId: ThreadId;
  };
  return <h1 data-testid="opened">{threadId}</h1>;
}

let root: Root | undefined;

afterEach(async () => {
  viewport.mobile = false;
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms = 100) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 4_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle(50);
  }
};

const mount = async (
  workspace: boolean,
  width = 1440,
  height = 900,
  seed: (server: ReturnType<typeof fakeServer>) => void = () => {},
  /** The settings context's `spaces`: the deployment turned Spaces on. */
  spaces = true,
) => {
  await page.viewport(width, height);
  const server = fakeServer();
  seed(server);
  const client = createQueryClient();
  client.setQueryData(projectKeys.lists(userId), {
    pages: [{ items: projects }],
    pageParams: [undefined],
  });
  client.setQueryData(personalAccountQueryOptions(userId).queryKey, {
    displayName: "Ada Owner",
    email: "ada@dx.test",
  } as never);
  client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    ...(workspace
      ? {
          activeScope: "workspace",
          workspace: {
            id: "wks_team",
            displayName: "Acme",
            shortName: "acme",
          },
        }
      : { activeScope: "personal" }),
    ...(spaces ? { spaces: true } : {}),
  } as never);
  client.setQueryData(threadKeys.shared(userId), []);
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
            </ThreadEditingProvider>
          </ThreadSnoozeProvider>
        </ThreadArchiveProvider>
      </CommandProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <h1 data-testid="opened">home</h1>,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: ThreadPageStub,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Ada Owner", email: "ada@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { server, router };
};

const section = () =>
  document.querySelector<HTMLElement>(
    ".product-sidebar section[aria-label='Spaces']",
  );
const spaceRows = () =>
  [
    ...(section()?.querySelectorAll<HTMLAnchorElement>("a.thread-row") ?? []),
  ].map((row) => ({
    name: row.querySelector(".thread-row-title-text")?.textContent,
    href: row.getAttribute("href"),
  }));
const opened = () =>
  document.querySelector("[data-testid='opened']")?.textContent;
const createDialog = () => document.querySelector<HTMLElement>(".space-create");
const discoverDialog = () =>
  document.querySelector<HTMLElement>(".space-discover-dialog");
const button = (scope: ParentNode | null, label: string) => {
  const found = [
    ...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Expected the ${label} button.`);
  return found;
};
/** The control a field's label names, in New Space. */
const field = <T extends HTMLElement>(label: string) => {
  const labelElement = [
    ...(createDialog()?.querySelectorAll<HTMLLabelElement>("label") ?? []),
  ].find((element) => element.textContent === label);
  const control = labelElement?.htmlFor
    ? document.getElementById(labelElement.htmlFor)
    : null;
  if (control === null) throw new Error(`Expected the ${label} field.`);
  return control as T;
};
const helpOf = (label: string) =>
  [...(createDialog()?.querySelectorAll(".space-field-label") ?? [])]
    .find((row) => row.querySelector("label")?.textContent === label)
    ?.querySelector("p")?.textContent;
const createButton = () => button(createDialog(), "Create SpaceEnter");
/** The open select's or combobox's options. */
const options = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".space-select-popup[data-open] .space-select-item .space-select-text",
    ),
  ].map((option) => option.textContent?.trim());
const shot = (name: string) =>
  page.screenshot({ path: `../../../.cache/spaces-ui/${name}.png` });

// Spaces is on only for the people a deployment names, and only while their
// flag is on (apps/core/src/spaces/gate.ts); the settings context says so.
it("shows no Spaces section, New Space, or Discover when Spaces is off", async () => {
  const { server } = await mount(true, 1440, 900, () => {}, false);
  await until(() => document.querySelector(".product-sidebar") !== null);
  await settle(300);
  expect(section()).toBeNull();
  expect(document.body.textContent).not.toContain("New Space");
  expect(document.body.textContent).not.toContain("Discover");
  expect(document.body.textContent).not.toContain("Spaces");
  expect(
    server.requests.filter((path) => path.startsWith("/v1/spaces")),
  ).toEqual([]);
  await shot("spaces-off-1440");

  // On, the same shell shows the section.
  await React.act(() => root?.unmount());
  document.body.replaceChildren();
  await mount(true);
  await until(() => section() !== null);
});

it("creates a Space from the sidebar, opens it, and lists it first in the sidebar", async () => {
  const { server } = await mount(true);
  await until(() => section()?.textContent?.includes("Start or join") === true);
  // Above the Threads, with its own actions, and no count while empty.
  const scroll = document.querySelector(".product-sidebar .sidebar-scroll");
  expect(scroll?.firstElementChild).toBe(section());
  expect(section()?.querySelector(".thread-group-meta")).toBeNull();
  button(section(), "Discover Spaces");
  await shot("sidebar-empty-1440");

  await userEvent.click(button(section(), "New Space"));
  await until(() => createDialog() !== null);
  const dialog = createDialog() as HTMLElement;
  expect(dialog.querySelector(".space-create-breadcrumb")?.textContent).toBe(
    "Spaces/Create",
  );
  expect(dialog.querySelector(".space-create-title")?.textContent).toBe(
    "What's this Space for?",
  );
  expect(dialog.textContent).toContain(
    "Pick up something you have been working on, or start something new.",
  );
  expect(helpOf("Name")).toBe(
    "Shown in the sidebar and at the top of the Space.",
  );
  expect(helpOf("Goal (optional)")).toBe(
    "What the work here is for. dx keeps the Space's threads directed toward it.",
  );
  expect(helpOf("Project")).toBe("The project the Space's threads run in.");
  expect(helpOf("Shared with")).toBe("Who can see the Space and chat in it.");
  expect(field("Shared with").textContent).toContain("Acme");
  await userEvent.click(field("Shared with"));
  await until(() => options().length === 2);
  expect(options()).toEqual([
    "Acme — Everyone can see it and chat",
    "Only You — Private",
  ]);
  await userEvent.keyboard("{Escape}");
  await until(() => !field("Shared with").hasAttribute("data-popup-open"));
  expect(createButton().disabled).toBe(true);
  await until(
    () => dialog.textContent?.includes("From your recent threads") === true,
  );
  await shot("create-space-1440");

  // Pick the second Project through the search.
  await userEvent.click(field("Project"));
  await until(() => options().length === 2);
  await userEvent.keyboard("Check");
  await until(() => options().length === 1);
  await userEvent.keyboard("{Enter}");
  await until(
    () => field("Project").textContent?.includes("Checkout") === true,
  );

  await userEvent.fill(field<HTMLInputElement>("Name"), "Checkout polish");
  await userEvent.fill(
    field<HTMLTextAreaElement>("Goal (optional)"),
    "Ship the new checkout flow",
  );
  expect(createButton().disabled).toBe(false);
  await shot("create-space-filled-1440");
  await userEvent.click(createButton());

  await until(() => opened() === NEW_SPACE);
  expect(server.created).toEqual([
    {
      name: "Checkout polish",
      goal: "Ship the new checkout flow",
      projectId: projects[1]?.id,
      sharing: "workspace",
    },
  ]);
  expect(createDialog()).toBeNull();
  await until(() => spaceRows().length === 1);
  expect(spaceRows()).toEqual([
    { name: "Checkout polish", href: `/threads/${NEW_SPACE}` },
  ]);
  // Listed, the heading counts the Spaces and collapses them.
  const heading = section()?.querySelector<HTMLButtonElement>(
    "button.thread-group-heading",
  );
  expect(heading?.querySelector("small")?.textContent).toBe("1");
  expect(section()?.querySelector(".sidebar-space-age")?.textContent).toBe(
    "now",
  );
  await shot("sidebar-with-space-1440");
  await userEvent.click(heading as HTMLButtonElement);
  expect(spaceRows()).toEqual([]);
  expect(heading?.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(heading as HTMLButtonElement);
  expect(spaceRows()).toHaveLength(1);
});

it("fills New Space from a suggestion and keeps the check only while unchanged", async () => {
  const { server } = await mount(true);
  await until(() => section() !== null);
  await userEvent.click(button(section(), "New Space"));
  await until(
    () => createDialog()?.querySelector(".space-suggestion") !== null,
  );
  const card = createDialog()?.querySelector<HTMLButtonElement>(
    ".space-suggestion",
  ) as HTMLButtonElement;
  expect(card.textContent).toBe(
    "Thread ReliabilityImprove thread execution, diagnostics, and file transfer reliability.2 recent threads · Checkout",
  );
  await userEvent.click(card);
  expect(field<HTMLInputElement>("Name").value).toBe("Thread Reliability");
  expect(field<HTMLTextAreaElement>("Goal (optional)").value).toBe(
    "Improve thread execution, diagnostics, and file transfer reliability.",
  );
  expect(field("Project").textContent).toContain("Checkout");
  expect(card.getAttribute("aria-pressed")).toBe("true");
  expect(card.querySelector(".space-suggestion-check")).not.toBeNull();
  await shot("create-space-suggestion-1440");

  await userEvent.type(field<HTMLInputElement>("Name"), "!");
  expect(card.getAttribute("aria-pressed")).toBe("false");
  await userEvent.fill(field<HTMLInputElement>("Name"), "Thread Reliability");
  expect(card.getAttribute("aria-pressed")).toBe("true");

  // Enter in the goal creates it, as the button's keycap says.
  await userEvent.click(field("Goal (optional)"));
  await userEvent.keyboard("{Enter}");
  await until(() => opened() === NEW_SPACE);
  expect(server.created).toEqual([
    {
      name: "Thread Reliability",
      goal: "Improve thread execution, diagnostics, and file transfer reliability.",
      projectId: projects[1]?.id,
      sharing: "workspace",
    },
  ]);
});

it("offers only a private Space to someone without a workspace", async () => {
  const { server } = await mount(false);
  await until(() => section() !== null);
  await userEvent.click(button(section(), "New Space"));
  await until(() => createDialog() !== null);
  await userEvent.click(field("Shared with"));
  await until(() => options().length === 1);
  expect(options()).toEqual(["Only You — Private"]);
  await userEvent.keyboard("{Escape}");
  await userEvent.fill(field<HTMLInputElement>("Name"), "Solo");
  await userEvent.click(createButton());
  await until(() => opened() === NEW_SPACE);
  expect(server.created).toEqual([
    { name: "Solo", projectId: projects[0]?.id, sharing: "private" },
  ]);
});

it("discovers a workspace Space and joins it, and says when nothing matches", async () => {
  const { server } = await mount(true);
  await until(() => section()?.textContent?.includes("Start or join") === true);
  await userEvent.click(button(section(), "Discover Spaces"));
  await until(
    () => discoverDialog()?.textContent?.includes("Payments") === true,
  );
  const dialog = discoverDialog() as HTMLElement;
  expect(dialog.querySelector("h2")?.textContent).toBe("Discover Spaces");
  expect(dialog.textContent).toContain("Spaces shared with your workspace");
  expect(dialog.textContent).toContain("Cut refund time in half");
  await shot("discover-1440");

  await userEvent.fill(
    dialog.querySelector<HTMLInputElement>(
      "input[aria-label='Search Spaces']",
    ) as HTMLInputElement,
    "zzz",
  );
  await until(() => dialog.textContent?.includes("No Spaces Match") === true);
  expect(dialog.querySelector(".space-discover-list")).toBeNull();
  await userEvent.fill(
    dialog.querySelector<HTMLInputElement>(
      "input[aria-label='Search Spaces']",
    ) as HTMLInputElement,
    "pay",
  );
  await until(() => dialog.textContent?.includes("Payments") === true);

  await userEvent.click(button(dialog, "Join"));
  await until(() => opened() === TEAM_SPACE);
  expect(server.joins).toEqual([TEAM_SPACE]);
  await until(() => spaceRows().length === 1);
  expect(spaceRows()).toEqual([
    { name: "Payments", href: `/threads/${TEAM_SPACE}` },
  ]);

  // With nothing left to join, the empty state offers New Space.
  await userEvent.click(button(section(), "Discover Spaces"));
  await until(
    () =>
      discoverDialog()?.textContent?.includes("Nothing New to Join Yet") ===
      true,
  );
  expect(discoverDialog()?.textContent).toContain(
    "When someone shares a Space with your workspace, it shows up here. Start your own in the meantime.",
  );
  await shot("discover-empty-1440");
  await userEvent.click(button(discoverDialog(), "New Space"));
  await until(() => createDialog() !== null);
  expect(discoverDialog()).toBeNull();
});

it("lays New Space and the section out for a phone", async () => {
  await mount(true, 390, 844);
  await until(() => section() !== null);
  await userEvent.click(button(section(), "New Space"));
  await until(
    () => createDialog()?.querySelector(".space-suggestion") !== null,
  );
  const dialog = createDialog() as HTMLElement;
  // One column: nothing wider than the screen.
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await shot("create-space-390");
});

it("shows a Space row's people as one overlapping row that leaves the name readable", async () => {
  const people = [
    { userId, name: "Ada Owner" },
    { userId: "usr_ben" as UserId, name: "Ben Member" },
    { userId: "usr_cy" as UserId, name: "Cy Third" },
    { userId: "usr_di" as UserId, name: "Di Fourth" },
  ];
  await mount(true, 1440, 900, (server) => {
    server.joined.push(
      space(TEAM_SPACE, { name: "Checkout probe", members: people }),
      space(NEW_SPACE, { name: "Ops", members: people }),
    );
  });
  await until(() => spaceRows().length === 2);
  await shot("sidebar-space-row-people-1440");
  const rows = [
    ...(section()?.querySelectorAll<HTMLElement>("a.sidebar-space-row") ?? []),
  ];
  for (const row of rows) {
    const rowBox = row.getBoundingClientRect();
    const stack = row.querySelector<HTMLElement>(".participant-stack");
    const stackBox = stack?.getBoundingClientRect();
    const avatars = [...row.querySelectorAll<HTMLElement>(".dx-avatar")].map(
      (avatar) => avatar.getBoundingClientRect(),
    );
    // At most three, side by side and overlapping, inside the row.
    expect(avatars).toHaveLength(3);
    for (const [index, box] of avatars.entries()) {
      expect(box.top).toBeCloseTo(avatars[0]?.top ?? 0, 0);
      expect(box.top).toBeGreaterThanOrEqual(rowBox.top);
      expect(box.bottom).toBeLessThanOrEqual(rowBox.bottom);
      const before = avatars[index - 1];
      if (before !== undefined) {
        expect(box.left).toBeGreaterThan(before.left);
        expect(box.left).toBeLessThan(before.right);
      }
    }
    // The name is shown whole, left of the people, who show at least one
    // face whole.
    const title = row.querySelector<HTMLElement>("strong");
    expect(title?.scrollWidth).toBeLessThanOrEqual(title?.clientWidth ?? 0);
    expect(title?.getBoundingClientRect().right).toBeLessThanOrEqual(
      stackBox?.left ?? 0,
    );
    expect(avatars[0]?.left).toBeGreaterThanOrEqual(stackBox?.left ?? 0);
    expect(avatars[0]?.right).toBeLessThanOrEqual(stackBox?.right ?? 0);
  }
  // With a short name, all three faces show.
  const short = rows[1]?.querySelector<HTMLElement>(".participant-stack");
  expect(short?.scrollWidth).toBeLessThanOrEqual(short?.clientWidth ?? 0);
});

it("ends a Space name too long for its row with an ellipsis and shows it whole on hover", async () => {
  const name = "Recall Tool Improvements";
  await mount(true, 1440, 900, (server) => {
    server.joined.push(
      space(TEAM_SPACE, {
        name,
        members: [
          { userId, name: "Ada Owner" },
          { userId: "usr_ben" as UserId, name: "Ben Member" },
        ],
      }),
    );
  });
  await until(() => spaceRows().length === 1);
  const row = section()?.querySelector<HTMLElement>("a.sidebar-space-row");
  const title = row?.querySelector<HTMLElement>("strong");
  expect(title?.textContent).toBe(name);
  // The part of the title that is cut ends in an ellipsis.
  const cut = [
    title,
    ...(title?.querySelectorAll<HTMLElement>("*") ?? []),
  ].filter(
    (element): element is HTMLElement =>
      element != null && element.scrollWidth > element.clientWidth,
  );
  expect(cut.length).toBeGreaterThan(0);
  for (const element of cut)
    expect(getComputedStyle(element).textOverflow).toBe("ellipsis");
  // Hovering shows the whole name.
  expect(title?.getAttribute("title")).toBe(name);
  await shot("sidebar-space-row-long-name-1440");
});

it("hides the first-thread doodle while the Spaces section lists Spaces", async () => {
  const doodle = () =>
    document.querySelector<HTMLElement>(
      ".product-sidebar .sidebar-first-thread",
    );
  const shown = () => {
    const element = doodle();
    return element !== null && element.getBoundingClientRect().height > 0;
  };
  // No Spaces and no threads: the doodle points at New Thread.
  await mount(true);
  await until(() => section()?.textContent?.includes("Start or join") === true);
  await until(shown);
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();

  // A Space but no threads: the section fills the sidebar instead.
  await mount(true, 1440, 900, (server) => {
    server.joined.push(space(TEAM_SPACE, { name: "Payments" }));
  });
  await until(() => spaceRows().length === 1);
  await settle(200);
  expect(shown()).toBe(false);
  await shot("sidebar-space-no-threads-1440");
});

const v2Shot = (name: string) =>
  page.screenshot({ path: `../../../.cache/spaces-v2-ui/${name}.png` });

it("shows a hover card beside a Space row with its name, last update, and colored mark", async () => {
  await mount(true, 1440, 900, (server) => {
    server.joined.push(
      space(TEAM_SPACE, {
        name: "Understanding Spaces",
        color: "green",
        lastActivityAt: new Date(
          Date.now() - 5 * 3_600_000,
        ).toISOString() as never,
      }),
      space(NEW_SPACE, { name: "codebase modular", color: "orange" }),
    );
  });
  await until(() => spaceRows().length === 2);
  const card = () => document.querySelector<HTMLElement>(".sidebar-space-card");
  const row = section()?.querySelector<HTMLElement>(
    `a[href='/threads/${TEAM_SPACE}']`,
  ) as HTMLElement;
  await userEvent.hover(row);
  await until(() => card() !== null);
  expect(card()?.getAttribute("role")).toBe("tooltip");
  expect(card()?.querySelector("strong")?.textContent).toBe(
    "Understanding Spaces",
  );
  expect(card()?.querySelector("small")?.textContent).toBe("Updated 5h ago");
  expect(
    card()?.querySelector(".space-icon")?.getAttribute("data-thread-color"),
  ).toBe("green");
  // Beside the row, level with it, not over the sidebar.
  const rowBox = row.getBoundingClientRect();
  const cardBox = card()?.getBoundingClientRect();
  expect(cardBox?.left ?? 0).toBeGreaterThanOrEqual(rowBox.right);
  expect(Math.abs((cardBox?.top ?? 0) - rowBox.top)).toBeLessThan(2);
  await v2Shot("sidebar-hover-card-1440");
  // Leaving the row hides it; another row shows its own.
  await userEvent.unhover(row);
  await until(() => card() === null);
  await userEvent.hover(
    section()?.querySelector<HTMLElement>(
      `a[href='/threads/${NEW_SPACE}']`,
    ) as HTMLElement,
  );
  await until(() => card() !== null);
  expect(card()?.querySelector("strong")?.textContent).toBe("codebase modular");
});

it("hides the left sidebar with its own toggle and shows it again", async () => {
  await mount(true, 1440, 900, (server) => {
    server.joined.push(space(TEAM_SPACE, { name: "Payments" }));
  });
  await until(() => spaceRows().length === 1);
  const sidebarWidth = () =>
    document
      .querySelector<HTMLElement>(".product-navigation-panel")
      ?.getBoundingClientRect().width ?? 0;
  expect(sidebarWidth()).toBeGreaterThan(200);
  await userEvent.click(
    document.querySelector<HTMLElement>(
      ".product-navigation-panel [data-command-action='toggle-sidebar']",
    ) as HTMLElement,
  );
  await until(() => sidebarWidth() < 1);
  const open = document.querySelector<HTMLElement>(
    "[data-command-action='toggle-sidebar'][aria-label='Open sidebar']",
  );
  expect(open).not.toBeNull();
  await v2Shot("sidebar-hidden-1440");
  await userEvent.click(open as HTMLElement);
  await until(() => sidebarWidth() > 200);
  expect(spaceRows()).toHaveLength(1);
});

it("shows a Space's own status beside its name and in its hover card, amber while it needs input", async () => {
  await mount(true, 1440, 900, (server) => {
    server.joined.push(
      space(TEAM_SPACE, {
        name: "Checkout",
        statusLine: "Waiting on Ada to pick a merchant ID",
        waitingOnInput: true,
      }),
      space(NEW_SPACE, { name: "Docs", statusLine: "Drafting the guide" }),
      space("thr_00000000-0000-4000-8000-0000000000c3" as ThreadId, {
        name: "Quiet",
      }),
    );
  });
  await until(() => spaceRows().length === 3);
  const row = (threadId: string) =>
    section()?.querySelector<HTMLElement>(
      `a[href='/threads/${threadId}']`,
    ) as HTMLElement;
  const status = (threadId: string) =>
    row(threadId).querySelector<HTMLElement>(".sidebar-space-status");
  expect(status(TEAM_SPACE)?.textContent).toBe(
    "Waiting on Ada to pick a merchant ID",
  );
  expect(status(TEAM_SPACE)?.hasAttribute("data-waiting")).toBe(true);
  expect(status(NEW_SPACE)?.textContent).toBe("Drafting the guide");
  expect(status(NEW_SPACE)?.hasAttribute("data-waiting")).toBe(false);
  expect(status("thr_00000000-0000-4000-8000-0000000000c3")).toBeNull();
  // The name keeps its room; the status gives way first.
  const name = row(TEAM_SPACE).querySelector("strong") as HTMLElement;
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
  await userEvent.hover(row(TEAM_SPACE));
  await until(
    () => document.querySelector(".sidebar-space-card-status") !== null,
  );
  expect(
    document.querySelector(".sidebar-space-card-status")?.textContent,
  ).toBe("Waiting on Ada to pick a merchant ID");
  await v2Shot("sidebar-space-status-1440");
});

// The Spaces section sits right under the pinned Threads and above every
// other Thread section, on a computer and in the phone drawer, with and
// without pinned Threads or Spaces, and with sections collapsed.
const PINNED = "thr_00000000-0000-4000-8000-0000000000d1" as ThreadId;
const RECENT = "thr_00000000-0000-4000-8000-0000000000d2" as ThreadId;
const orderShot = (name: string) =>
  page.screenshot({ path: `../../../.cache/spaces-order-ui/${name}.png` });
/** The Thread list's sections, top to bottom: "spaces" or a section id. */
const sidebarOrder = () =>
  [
    ...(document.querySelector(
      viewport.mobile
        ? ".mobile-sidebar-drawer nav[aria-label='Threads']"
        : ".product-sidebar nav[aria-label='Threads']",
    )?.children ?? []),
  ]
    .map((element) =>
      element.matches("section[aria-label='Spaces']")
        ? "spaces"
        : element.getAttribute("data-thread-section"),
    )
    .filter((name) => name !== null);
const mountWith = async (
  {
    spaces,
    pinned,
    mobile = false,
  }: { spaces: boolean; pinned: boolean; mobile?: boolean },
  width = mobile ? 390 : 1440,
  height = mobile ? 844 : 900,
) => {
  viewport.mobile = mobile;
  await mount(false, width, height, (server) => {
    server.threads.push({ id: RECENT, title: "Recent work" });
    if (pinned)
      server.threads.push({ id: PINNED, title: "Pinned work", pinned: true });
    if (spaces) server.joined.push(space(TEAM_SPACE, { name: "Payments" }));
  });
  if (mobile) {
    await userEvent.click(page.getByRole("button", { name: "Open sidebar" }));
  }
  await until(() => sidebarOrder().length >= (pinned ? 3 : 2));
  if (spaces) await until(() => spaceRows().length === 1);
  await settle(200);
};
const remount = async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
};

it("lists Spaces below the pinned Threads and above the rest, on a computer and a phone", async () => {
  await mountWith({ spaces: true, pinned: true });
  await orderShot("pinned-spaces-1440");
  expect
    .soft(sidebarOrder())
    .toEqual(["pinned", "spaces", projects[0]?.id, "snoozed", "archived"]);
  // The pinned Thread's row is above the Space's row on screen too.
  const pinnedRow = document.querySelector(
    `.product-sidebar a[href='/threads/${PINNED}']`,
  ) as HTMLElement;
  const spaceRow = document.querySelector(
    `.product-sidebar a[href='/threads/${TEAM_SPACE}']`,
  ) as HTMLElement;
  const recentRow = document.querySelector(
    `.product-sidebar a[href='/threads/${RECENT}']`,
  ) as HTMLElement;
  expect
    .soft(pinnedRow.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(spaceRow.getBoundingClientRect().top);
  expect(spaceRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    recentRow.getBoundingClientRect().top,
  );

  // Collapsed Spaces and a collapsed Project keep their places.
  await userEvent.click(
    section()?.querySelector<HTMLButtonElement>(
      "button.thread-group-heading",
    ) as HTMLButtonElement,
  );
  await until(() => spaceRows().length === 0);
  await userEvent.click(
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".product-sidebar [data-thread-section] > .thread-group-heading",
      ),
    ].find((heading) =>
      heading.textContent?.includes("Website"),
    ) as HTMLButtonElement,
  );
  await until(
    () =>
      document.querySelector(
        `.product-sidebar a[href='/threads/${RECENT}']`,
      ) === null,
  );
  await orderShot("pinned-spaces-collapsed-1440");
  expect
    .soft(sidebarOrder())
    .toEqual(["pinned", "spaces", projects[0]?.id, "snoozed", "archived"]);

  // No pinned Threads: Spaces leads.
  await remount();
  await mountWith({ spaces: true, pinned: false });
  await orderShot("no-pinned-1440");
  expect
    .soft(sidebarOrder())
    .toEqual(["spaces", projects[0]?.id, "snoozed", "archived"]);

  // No Spaces: the empty section still sits under the pinned Threads.
  await remount();
  await mountWith({ spaces: false, pinned: true });
  await until(() => section()?.textContent?.includes("Start or join") === true);
  await orderShot("no-spaces-1440");
  expect
    .soft(sidebarOrder())
    .toEqual(["pinned", "spaces", projects[0]?.id, "snoozed", "archived"]);

  // The phone drawer lists them in the same order.
  await remount();
  await mountWith({ spaces: true, pinned: true, mobile: true });
  await orderShot("pinned-spaces-390");
  expect
    .soft(sidebarOrder())
    .toEqual(["pinned", "spaces", projects[0]?.id, "snoozed", "archived"]);
});
