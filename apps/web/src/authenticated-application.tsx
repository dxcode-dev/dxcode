import type { QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { attachInAppNavigation } from "./features/install-app/in-app-navigation.js";
import { RealtimeProvider } from "./features/threads/realtime/realtime-provider.js";
import { ThreadSessionProvider } from "./features/threads/thread-session-provider.js";
import { type AppRouter, createAppRouter } from "./router.js";
import { useIdentity } from "./shared/auth/auth-context.js";
import { useMountEffect } from "./shared/hooks/use-mount-effect.js";

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((module) => ({
        default: module.ReactQueryDevtools,
      })),
    )
  : undefined;

/**
 * Lends the router to notification clicks, app launches, and dx links in the
 * installed app, so each changes route in place instead of reloading dx.
 */
function InAppNavigation({ router }: { readonly router: AppRouter }) {
  useMountEffect(() =>
    attachInAppNavigation((url) => {
      // Paths the router has no page for, such as `/v1/…`, load as documents.
      if (router.getMatchedRoutes(url.pathname)[2] === undefined) return false;
      void router.navigate({ href: url.pathname + url.search + url.hash });
      return true;
    }),
  );
  return null;
}

/** Builds the signed-in product router with the application-owned query client. */
export function AuthenticatedApplication({
  queryClient,
}: {
  readonly queryClient: QueryClient;
}) {
  const auth = useIdentity();
  if (auth === undefined)
    throw new Error(
      "AuthenticatedApplication must be rendered inside AuthGate.",
    );
  const router = createAppRouter({
    queryClient,
    userId: auth.identity.id,
  });
  return (
    <ThreadSessionProvider
      key={auth.identity.id}
      userId={auth.identity.id}
      queryClient={queryClient}
    >
      <RealtimeProvider queryClient={queryClient} userId={auth.identity.id}>
        <RouterProvider router={router} />
        <InAppNavigation key={auth.identity.id} router={router} />
        {ReactQueryDevtools === undefined ? null : (
          <Suspense fallback={null}>
            <ReactQueryDevtools />
          </Suspense>
        )}
      </RealtimeProvider>
    </ThreadSessionProvider>
  );
}
