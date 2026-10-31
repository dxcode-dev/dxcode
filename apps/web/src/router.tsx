import { ProjectId, ThreadId, type UserId, WorkspaceSlug } from "@dx/domain";
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
import { InstallAppBanner } from "./features/install-app/install-app-banner.js";
import { ProductShell } from "./features/navigation/product-shell.js";
import {
  isMissingProjectError,
  projectQueryOptions,
  seedProjectDetailFromList,
} from "./features/projects/project-queries.js";
import {
  ProjectRouteError,
  ProjectRouteNotFound,
} from "./features/projects/project-route-states.js";
import { isProjectSettingsSection } from "./features/projects/project-settings-sections.js";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";
import { resolveSettingsSection } from "./features/settings/settings-registration.js";
import { SettingsRouteNotFound } from "./features/settings/settings-route-not-found.js";
import {
  NewThreadPage,
  NewThreadProvider,
} from "./features/threads/new-thread-page.js";
import { ThreadArchiveProvider } from "./features/threads/thread-archive.js";
import { ThreadEditingProvider } from "./features/threads/thread-editing.js";
import { openThreadSeen } from "./features/threads/thread-seen-mutations.js";
import { ThreadSnoozeProvider } from "./features/threads/thread-snooze.js";
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
  threadTree: lazyRouteComponent(
    () => import("./thread-tree-route.js"),
    "ThreadTreeRoute",
  ),
  bugReports: lazyRouteComponent(
    () => import("./features/threads/bug-reports/bug-report-page.js"),
    "BugReportsRoute",
  ),
  bugReport: lazyRouteComponent(
    () => import("./features/threads/bug-reports/bug-report-page.js"),
    "BugReportRoute",
  ),
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

const productNotices = <InstallAppBanner />;

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
      <ThreadSnoozeProvider>
        <ThreadEditingProvider>
          <ProductShell notices={productNotices} />
        </ThreadEditingProvider>
      </ThreadSnoozeProvider>
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
  await queryClient
    .ensureQueryData(projectQueryOptions(userId, id))
    .catch((error: unknown) => {
      // A missing project renders the route's not-found state inside the
      // shell. Other failures reach the route's error state.
      if (isMissingProjectError(error))
        throw notFound({
          data: { code: "PROJECT_NOT_FOUND", projectId: id },
        });
      throw error;
    });
  return id;
};

const projectRouteStates = {
  notFoundComponent: ProjectRouteNotFound,
  errorComponent: ProjectRouteError,
} as const;

const projectRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId",
  loader: async ({ context, params }) => {
    await ensureProjectRouteData(context, params.projectId);
  },
  component: page.project,
  ...projectRouteStates,
});

const bugReportsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/bug-reports",
  component: page.bugReports,
});

const bugReportRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/bug-reports/$reportId",
  component: page.bugReport,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings",
  loader: async ({ context, params }) => {
    await ensureProjectRouteData(context, params.projectId);
  },
  component: page.projectSettings,
  ...projectRouteStates,
});

const projectSettingsSectionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/projects/$projectId/settings/$section",
  // A missing project takes precedence over an unknown section.
  loader: async ({ context, params }) => {
    const id = await ensureProjectRouteData(context, params.projectId);
    if (!isProjectSettingsSection(params.section))
      throw notFound({
        data: {
          code: "PROJECT_SETTINGS_SECTION_NOT_FOUND",
          projectId: id,
          section: params.section,
        },
      });
  },
  component: page.projectSettings,
  ...projectRouteStates,
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

const seeOpenedThread = ({
  context,
  params,
}: {
  readonly context: RouterContext;
  readonly params: { readonly threadId: string };
}) => {
  const threadId = Schema.decodeUnknownOption(ThreadId)(params.threadId);
  if (Option.isSome(threadId))
    openThreadSeen(context.queryClient, context.userId, threadId.value);
};

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
  // Opening a Thread is seeing it: entering the route, or moving within it
  // from one Thread to the next. Not loading it: hovering a link preloads
  // the route, and the click that follows reuses that match unloaded.
  onEnter: seeOpenedThread,
  onStay: seeOpenedThread,
  component: page.thread,
});

const threadTreeRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/threads/$threadId/tree",
  component: page.threadTree,
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

// Instructions lived at /settings/advanced; keep old links working.
const personalAdvancedSettingsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/advanced",
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "instructions" },
      state: location.state,
      replace: true,
    });
  },
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
    threadTreeRoute,
    bugReportsRoute,
    bugReportRoute,
  ]),
  personalSettingsRoute,
  personalAdvancedSettingsRedirectRoute,
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
