import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
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

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  validateSearch: validateSignInSearch,
  component: JoinSignInRoute,
});

/** Any other signed-out URL asks for sign-in and comes back afterwards. */
const anyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/signin",
      search: { next: location.href },
      replace: true,
    });
  },
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  signInRoute,
  signUpRoute,
  joinRoute,
  anyRoute,
]);

/** Routes for signed-out visitors; the signed-in product router replaces it after sign-in. */
export const createPublicRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, context: { queryClient } });
