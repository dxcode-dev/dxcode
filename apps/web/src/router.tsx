import { ProjectId, type UserId, WorkspaceSlug } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  Outlet,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";
import {
  isServerPath,
  safeNextPath,
  validateSignInSearch,
} from "./features/authentication/sign-in-paths.js";
import { ProductShell } from "./features/navigation/product-shell.js";
import {
  projectQueryOptions,
  seedProjectDetailFromList,
} from "./features/projects/project-queries.js";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";
import { resolveSettingsSection } from "./features/settings/settings-registration.js";
import { SettingsRouteNotFound } from "./features/settings/settings-route-not-found.js";
import {
  NewThreadPage,
  NewThreadProvider,
} from "./features/threads/new-thread-page.js";
import { ThreadArchiveProvider } from "./features/threads/thread-archive.js";
import { ThreadEditingProvider } from "./features/threads/thread-editing.js";
import { isStaleChunkError } from "./shared/stale-chunk.js";

export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly userId: UserId;
}

// Each page loads as its own chunk, so the first visit downloads only the
// shell and the page it lands on; links preload a page's chunk on intent.
const page = {
  home: lazyRouteComponent(
    () => import("./features/home/home-page.js"),
    "HomePage",
  ),
  projects: lazyRouteComponent(
    () => import("./features/projects/projects-page.js"),
    "ProjectsPage",
  ),
  project: lazyRouteComponent(
    () => import("./features/projects/project-page.js"),
    "ProjectPage",
  ),
  projectSettings: lazyRouteComponent(
    () => import("./project-settings-route.js"),
    "ProjectSettingsRoute",
  ),
  thread: lazyRouteComponent(() => import("./thread-route.js"), "ThreadRoute"),
  joinWorkspace: lazyRouteComponent(
    () => import("./features/settings/members/join-workspace-page.js"),
    "JoinWorkspacePage",
  ),
};

const settingsPage = (
  name:
    | "PersonalSettingsRoot"
    | "PersonalSettingsSection"
    | "WorkspaceSettingsRoot"
    | "WorkspaceSettingsEmptyRoot"
    | "WorkspaceSettingsSection",
) =>
  lazyRouteComponent(
    () => import("./features/settings/settings-route-components.js"),
    name,
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
      <ThreadEditingProvider>
        <ProductShell />
      </ThreadEditingProvider>
    </ThreadArchiveProvider>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/",
  component: page.home,
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
  component: page.projects,
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
  component: page.project,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings",
  loader: ({ context, params }) =>
    ensureProjectRouteData(context, params.projectId),
  component: page.projectSettings,
});

const projectSettingsSectionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings/$section",
  loader: ({ context, params }) =>
    ensureProjectRouteData(context, params.projectId),
  component: page.projectSettings,
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
  // `message` opens the Thread at a message, for example a mention.
  validateSearch: (
    search: Record<string, unknown>,
  ): { readonly message?: string } =>
    typeof search.message === "string" &&
    /^msg_[0-9a-f]{24}$/.test(search.message)
      ? { message: search.message }
      : {},
  component: page.thread,
});

const registeredSettingsSection = async (
  scope: "personal" | "workspace",
  section?: string,
) => {
  // The manifest carries every section's component; load it with the page.
  // A tab opened before a deploy cannot load the old chunk. Resolve nothing
  // then: the settings page's lazy route component needs the same chunk,
  // fails on it, and TanStack reloads the page once to pick up the new build.
  const settingsManifest = await import(
    "./features/settings/foundation-sections.js"
  ).then(
    (module) => module.settingsManifest,
    (error: unknown) => {
      if (isStaleChunkError(error)) return undefined;
      throw error;
    },
  );
  if (settingsManifest === undefined) return undefined;
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
  component: settingsPage("PersonalSettingsRoot"),
  notFoundComponent: SettingsRouteNotFound,
});

const personalSettingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  loader: ({ params }) => registeredSettingsSection("personal", params.section),
  component: settingsPage("PersonalSettingsSection"),
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceSlug",
  // An unknown section takes precedence over a malformed slug.
  loader: async ({ params }) => {
    const registration = await registeredSettingsSection("workspace");
    return { registration, workspaceSlug: workspaceSlug(params.workspaceSlug) };
  },
  component: settingsPage("WorkspaceSettingsRoot"),
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsEmptyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces",
  loader: () => registeredSettingsSection("workspace"),
  component: settingsPage("WorkspaceSettingsEmptyRoot"),
  notFoundComponent: SettingsRouteNotFound,
});

const workspaceSettingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceSlug/$section",
  loader: async ({ params }) => {
    const registration = await registeredSettingsSection(
      "workspace",
      params.section,
    );
    return { registration, workspaceSlug: workspaceSlug(params.workspaceSlug) };
  },
  component: settingsPage("WorkspaceSettingsSection"),
  notFoundComponent: SettingsRouteNotFound,
});

const joinWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  // Provider redirects can return here with `?error=` before sign-in.
  validateSearch: validateSignInSearch,
  component: page.joinWorkspace,
});

// Signing in lands on the sign-in page with a session; continue to `next`,
// which safeNextPath limits to a same-origin path.
const signedInRedirect = ({ search }: { search: { next?: string } }) => {
  const next = safeNextPath(search.next) ?? "/";
  // react-doctor-disable-next-line react-doctor/clickjacking-redirect-risk
  throw redirect({
    href: next,
    replace: true,
    // A server route (the Portal sign-in) continues as a document load.
    ...(isServerPath(next) ? { reloadDocument: true } : {}),
  });
};

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  validateSearch: validateSignInSearch,
  beforeLoad: signedInRedirect,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  validateSearch: validateSignInSearch,
  beforeLoad: signedInRedirect,
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
  joinWorkspaceRoute,
  signInRoute,
  signUpRoute,
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
