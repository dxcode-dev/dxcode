// The Projects list and a Project page, under a real TanStack router with the
// app's route IDs. Only the network is replaced: the query cache is seeded,
// Create Project is answered through the product's own decoder, and every
// other request stays pending.
import { ProjectDataSchema } from "@dx/api";
import {
  type ProjectId,
  ProjectId as ProjectIdSchema,
  RunnerProfileId,
  UserId,
} from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({
    identity: { id: "user-1", name: "Test User", email: "test@example.com" },
  }),
}));

import { NewThreadSurfaceContext } from "../../shared/new-thread-surface.js";
import { bitbucketConnectionQueryOptions } from "../settings/integrations/bitbucket-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import { ProjectPage } from "./project-page.js";
import {
  projectQueryOptions,
  projectsQueryOptions,
} from "./project-queries.js";
import { ProjectsPage } from "./projects-page.js";
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const projectData = (id: string, name: string) =>
  Schema.decodeUnknownSync(ProjectDataSchema)({
    id,
    name,
    configuration: {
      shipAction: "ship",
      commitAuthor: { preference: "dx", name: "dx", email: "noreply@dx.local" },
      signingPreference: "disabled",
      runnerProfileId: Schema.decodeUnknownSync(RunnerProfileId)("e2b-default"),
      publicCodeEnabled: false,
      dxCoAuthor: true,
    },
    revision: 0,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  });
const existing = projectData(
  "prj_00000000-0000-4000-8000-000000000001",
  "existing-project",
);
const created = projectData(
  "prj_00000000-0000-4000-8000-000000000002",
  "qa-nt-hello",
);

let root: Root | undefined;

afterEach(async () => {
  if (root !== undefined) await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Records each New Thread surface invocation, as the product shell owns it. */
const newThreadSurface = () => {
  const opened: Array<ProjectId | undefined> = [];
  return {
    opened,
    value: { openNewThread: (projectId?: ProjectId) => opened.push(projectId) },
  };
};

const mount = async (initialPath: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = { pageParams: [undefined], pages: [{ items: [existing] }] };
  queryClient.setQueryData(
    projectsQueryOptions(userId).queryKey,
    page as never,
  );
  queryClient.setQueryData(
    projectQueryOptions(userId, existing.id).queryKey,
    existing,
  );
  queryClient.setQueryData(threadsQueryOptions(userId, existing.id).queryKey, {
    pageParams: [undefined],
    pages: [{ items: [] }],
  } as never);
  queryClient.setQueryData(
    settingsContextQueryOptions(userId).queryKey,
    {} as never,
  );
  queryClient.setQueryData(sourceGrantsQueryOptions(userId).queryKey, []);
  queryClient.setQueryData(bitbucketConnectionQueryOptions(userId).queryKey, {
    connection: null,
  } as never);
  const posted: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin).pathname;
    if (init?.method === "POST" && url === "/v1/projects") {
      posted.push(String(init.body));
      return Promise.resolve(
        Response.json({ status: "success", data: created }),
      );
    }
    return new Promise<Response>(() => undefined);
  });

  const surface = newThreadSurface();
  const rootRoute = createRootRoute({
    component: () => (
      <NewThreadSurfaceContext.Provider value={surface.value}>
        <Outlet />
      </NewThreadSurfaceContext.Provider>
    ),
  });
  const productRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
    component: Outlet,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      productRoute.addChildren([
        createRoute({
          getParentRoute: () => productRoute,
          path: "/",
          component: () => <p>Home</p>,
        }),
        createRoute({
          getParentRoute: () => productRoute,
          path: "/projects",
          validateSearch: (search: Record<string, unknown>) =>
            search.owner === "workspace" || search.owner === "personal"
              ? { owner: search.owner }
              : {},
          component: ProjectsPage,
        }),
        createRoute({
          getParentRoute: () => productRoute,
          path: "/projects/$projectId",
          component: ProjectPage,
        }),
        createRoute({
          getParentRoute: () => productRoute,
          path: "/new",
          validateSearch: (search: Record<string, unknown>) => ({
            project: Schema.decodeUnknownOption(ProjectIdSchema)(
              search.project,
            ).pipe((option) =>
              option._tag === "Some" ? option.value : undefined,
            ),
          }),
          component: () => <p>New Thread page</p>,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  return { router, opened: surface.opened, posted };
};

const buttonNamed = (name: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll<HTMLElement>("button, a")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`Missing button: ${name}`);
  return found;
};

const type = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`Missing input: ${selector}`);
  await React.act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe("Project page New Thread (#1134)", () => {
  it("opens the composer over the project from the empty state, as the title bar does", async () => {
    const { router, opened } = await mount(`/projects/${existing.id}`);
    const emptyState = document.querySelector(".project-recent-empty");
    expect(emptyState?.textContent).toContain("No threads yet");

    await React.act(() =>
      buttonNamed("New Thread", emptyState ?? document).click(),
    );
    await settle();

    expect(router.state.location.pathname).toBe(`/projects/${existing.id}`);
    expect(document.body.textContent).toContain("existing-project");
    expect(opened).toEqual([existing.id]);

    const titleBar = document.querySelector(".project-detail-actions");
    await React.act(() =>
      buttonNamed("New Thread", titleBar ?? document).click(),
    );
    expect(opened).toEqual([existing.id, existing.id]);
    expect(router.state.location.pathname).toBe(`/projects/${existing.id}`);
  });
});

describe("Create Project with a search filter (#1139)", () => {
  it("clears the filter so the new project is listed", async () => {
    const { posted } = await mount("/projects?owner=personal");
    await type('input[aria-label="Search projects"]', "zzznomatch");
    expect(document.body.textContent).toContain("No projects match");

    await React.act(() => buttonNamed("New Project").click());
    await React.act(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((element) =>
          element.textContent?.includes("Use an Existing Repository"),
        )
        ?.click(),
    );
    await type("#project-repository", "https://github.com/octocat/Hello-World");
    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open repository list"]')
        ?.click(),
    );
    await React.act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) =>
          option.textContent?.includes(
            "https://github.com/octocat/Hello-World",
          ),
        )
        ?.click(),
    );
    await React.act(() => buttonNamed("Continue").click());
    await type("#project-name", "qa-nt-hello");
    await React.act(() => buttonNamed("Create Project").click());
    await settle();

    expect(posted).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search projects"]',
      )?.value,
    ).toBe("");
    const rows = [...document.querySelectorAll(".project-list-row strong")].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual(["qa-nt-hello", "existing-project"]);
    expect(document.body.textContent).not.toContain("No projects match");
  });
});
