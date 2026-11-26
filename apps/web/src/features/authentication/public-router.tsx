import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouteComponent,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { nativeShell } from "../../shared/native-shell/native-shell.js";
import { HostedApps } from "./hosted-landing.js";
import { JoinSignInRoute } from "./join-sign-in-route.js";
import { PublicHome } from "./public-home.js";
import { validateSignInSearch } from "./sign-in-paths.js";
import { SignInRoute } from "./sign-in-route.js";

interface PublicRouterContext {
  readonly queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<PublicRouterContext>()({
  component: Outlet,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // An app (the Mac app) opens dx to sign in, not to its public home page.
  beforeLoad: () => {
    if (nativeShell() !== undefined)
      throw redirect({ to: "/signin", replace: true });
  },
  component: PublicHome,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  validateSearch: validateSignInSearch,
  component: SignInRoute,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  validateSearch: validateSignInSearch,
  component: SignInRoute,
});

// dxcode.dev/apps, hosted dx only. Elsewhere the router has no /apps, as
// Core lists none (DEPLOYMENT_PAGE_PATHS), so the catch-all handles it.
const appsRoute =
  HostedApps === undefined
    ? undefined
    : createRoute({
        getParentRoute: () => rootRoute,
        path: "/apps",
        component: HostedApps as RouteComponent,
      });

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  validateSearch: validateSignInSearch,
  component: JoinSignInRoute,
});

/**
 * Any other signed-out URL: a dx page asks for sign-in and comes back
 * afterwards; anything else is not a page, and says so.
 */
const anyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  beforeLoad: async ({ location }) => {
    const { isAppRoutePath } = await import("../not-found/app-route-check.js");
    if (!isAppRoutePath(location.pathname)) return;
    throw redirect({
      to: "/signin",
      search: { next: location.href },
      replace: true,
    });
  },
  component: lazyRouteComponent(
    () => import("../not-found/not-found-page.js"),
    "NotFoundPage",
  ),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  ...(appsRoute === undefined ? [] : [appsRoute]),
  signInRoute,
  signUpRoute,
  joinRoute,
  anyRoute,
]);

/** Routes for signed-out visitors; the signed-in product router replaces it after sign-in. */
export const createPublicRouter = (
  queryClient: QueryClient,
  history?: RouterHistory,
) =>
  createRouter({
    routeTree,
    context: { queryClient },
    ...(history === undefined ? {} : { history }),
  });
