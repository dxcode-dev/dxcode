import { useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import {
  keptRouter,
  routerLoaded,
  useBootQuery,
} from "../../shared/boot/boot-wait.js";
import { HostedLanding } from "./hosted-landing.js";
import { createPublicRouter } from "./public-router.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";
import { SignInUnavailable } from "./sign-in-unavailable.js";

// A launch at `/` shows the landing page: its code starts loading with this
// module, and the boot screen waits for it, so the router's first frame is
// the page and not a blank. (A router loader on `/` did the same, but a
// first load with a loader sometimes never settled before the router
// mounted.)
const landingLoaded =
  window.location.pathname === "/" ? HostedLanding?.preload?.() : undefined;

/**
 * The signed-out pages: home, sign-in, sign-up, and invite links. AuthGate
 * loads this module lazily, so a signed-in first load ships none of it.
 * It suspends until the sign-in options and the first page are ready, so the
 * boot screen hands over straight to that page.
 */
export function SignedOut() {
  const queryClient = useQueryClient();
  const options = useBootQuery(signInOptionsQueryOptions);
  if (options.isError)
    return (
      <SignInUnavailable
        message="Sign-in isn't available right now. Check your connection and try again."
        onRetry={() => void options.refetch()}
      />
    );
  const router = keptRouter(queryClient, "public", () =>
    createPublicRouter(queryClient),
  );
  if (landingLoaded !== undefined) React.use(landingLoaded);
  React.use(routerLoaded(router));
  return <RouterProvider router={router} />;
}
