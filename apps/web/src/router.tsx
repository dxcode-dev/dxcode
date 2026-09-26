import { ProjectId, type UserId, WorkspaceSlug } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { HomePage } from "./features/home/home-page.js";
import { ProductShell } from "./features/navigation/product-shell.js";
import { ProjectPage } from "./features/projects/project-page.js";
import {
  projectQueryOptions,
  seedProjectDetailFromList,
} from "./features/projects/project-queries.js";
import { ProjectSettingsPage } from "./features/projects/project-settings-page.js";
import { ProjectsPage } from "./features/projects/projects-page.js";
import { ProjectEnvironmentVariablesSettings } from "./features/settings/environment-variables/environment-variables-settings.js";
import { settingsManifest } from "./features/settings/foundation-sections.js";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";
import { SettingsRouteNotFound } from "./features/settings/settings-page.js";
import { resolveSettingsSection } from "./features/settings/settings-registration.js";
import {
  PersonalSettingsRoot,
  PersonalSettingsSection,
  WorkspaceSettingsEmptyRoot,
  WorkspaceSettingsRoot,
  WorkspaceSettingsSection,
} from "./features/settings/settings-route-components.js";
import { ThreadTerminal } from "./features/terminal/thread-terminal.js";
import {
  NewThreadPage,
  NewThreadProvider,
} from "./features/threads/new-thread-page.js";
import { ThreadArchiveProvider } from "./features/threads/thread-archive.js";
import { ThreadWorkspace } from "./features/threads/thread-workspace.js";

export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly userId: UserId;
}

const ProjectSettingsRoute = () => (
  <ProjectSettingsPage
    renderEnvironmentSettings={(projectId, onDirtyChange) => (
      <ProjectEnvironmentVariablesSettings
        projectId={projectId}
        onDirtyChange={onDirtyChange}
      />
    )}
  />
);

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <NewThreadProvider>
      <Outlet />
    </NewThreadProvider>
  ),
});

const productRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_product",
  component: () => (
    <ThreadArchiveProvider>
      <ProductShell />
    </ThreadArchiveProvider>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/",
  component: HomePage,
});

const projectsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects",
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    readonly owner?: "workspace" | "personal";
  } => {
    const owner = Option.getOrUndefined(
      Schema.decodeUnknownOption(
        Schema.Union([Schema.Literal("workspace"), Schema.Literal("personal")]),
      )(search.owner),
    );
    return owner === undefined ? {} : { owner };
  },
  component: ProjectsPage,
});

const projectId = (input: string) => {
  const result = Schema.decodeUnknownOption(ProjectId)(input);
  if (Option.isNone(result)) {
    throw notFound({
      data: {
        code: "INVALID_PROJECT_ID",
        field: "projectId",
      },
    });
  }
  return result.value;
};

export const ensureProjectRouteData = async (
  { queryClient, userId }: RouterContext,
  projectIdParam: string,
) => {
  const id = projectId(projectIdParam);
  seedProjectDetailFromList(queryClient, userId, id);
  await queryClient.ensureQueryData(projectQueryOptions(userId, id));
};

const projectRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId",
  loader: ({ context, params }) =>
    ensureProjectRouteData(context, params.projectId),
  component: ProjectPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings",
  loader: ({ context, params }) =>
    ensureProjectRouteData(context, params.projectId),
  component: ProjectSettingsRoute,
});

const projectSettingsSectionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings/$section",
  loader: ({ context, params }) =>
    ensureProjectRouteData(context, params.projectId),
  component: ProjectSettingsRoute,
});

const newThreadRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/new",
  validateSearch: (search: Record<string, unknown>) => ({
    project: Option.getOrUndefined(
      Schema.decodeUnknownOption(ProjectId)(search.project),
    ),
  }),
  loader: ({ context }) =>
    context.queryClient.prefetchQuery(
      settingsContextQueryOptions(context.userId),
    ),
  component: NewThreadPage,
});

const threadRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/threads/$threadId",
  component: () => <ThreadWorkspace Terminal={ThreadTerminal} />,
});

const registeredSettingsSection = (
  scope: "personal" | "workspace",
  section?: string,
) => {
  const result = resolveSettingsSection(settingsManifest, scope, section);
  if (!result.found) throw notFound({ data: result.error });
  return result.registration;
};

const workspaceSlug = (input: string) => {
  const result = Schema.decodeUnknownOption(WorkspaceSlug)(input);
  if (Option.isNone(result)) {
    throw notFound({
      data: {
        code: "INVALID_SETTINGS_SCOPE",
        field: "workspaceSlug",
      },
    });
  }
  return result.value;
};

const personalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  loader: () => registeredSettingsSection("personal"),
  component: PersonalSettingsRoot,
  notFoundComponent: SettingsRouteNotFound,
});

const personalSettingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  loader: ({ params }) => registeredSettingsSection("personal", params.section),
  component: PersonalSettingsSection,
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceSlug",
  loader: ({ params }) => ({
    registration: registeredSettingsSection("workspace"),
    workspaceSlug: workspaceSlug(params.workspaceSlug),
  }),
  component: WorkspaceSettingsRoot,
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsEmptyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces",
  loader: () => registeredSettingsSection("workspace"),
  component: WorkspaceSettingsEmptyRoot,
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceSlug/$section",
  loader: ({ params }) => ({
    registration: registeredSettingsSection("workspace", params.section),
    workspaceSlug: workspaceSlug(params.workspaceSlug),
  }),
  component: WorkspaceSettingsSection,
  notFoundComponent: SettingsRouteNotFound,
});

const routeTree = rootRoute.addChildren([
  productRoute.addChildren([
    indexRoute,
    projectsRoute,
    projectRoute,
    projectSettingsRoute,
    projectSettingsSectionRoute,
    newThreadRoute,
    threadRoute,
  ]),
  personalSettingsRoute,
  personalSettingsSectionRoute,
  workspaceSettingsEmptyRoute,
  workspaceSettingsRoute,
  workspaceSettingsSectionRoute,
]);

export const createAppRouter = (
  context: RouterContext,
  history?: RouterHistory,
) =>
  createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    scrollRestoration: ({ location }) =>
      !location.pathname.startsWith("/threads/"),
    ...(history === undefined ? {} : { history }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
