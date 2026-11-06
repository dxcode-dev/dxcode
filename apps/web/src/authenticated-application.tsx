import type { QueryClient } from "@tanstack/react-query";
import { RouterProvider, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { attachInAppNavigation } from "./features/install-app/in-app-navigation.js";
import { FeedbackWidgetOnDx } from "./features/projects/feedback-widget-on-dx.js";
import { recordBrowserTimeZone } from "./features/threads/automations/automations-queries.js";
import { RealtimeProvider } from "./features/threads/realtime/realtime-provider.js";
import { ThreadSessionProvider } from "./features/threads/thread-session-provider.js";
import { type AppRouter, createAppRouter } from "./router.js";
import { useIdentity } from "./shared/auth/auth-context.js";
import { ReportBugSlot } from "./shared/bug-reports/report-bug-slot.js";
import { useMountEffect } from "./shared/hooks/use-mount-effect.js";
import { Toaster } from "./shared/ui/sonner.js";
import { useMobile } from "./shared/use-mobile.js";

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((module) => ({
        default: module.ReactQueryDevtools,
      })),
    )
  : undefined;

/** Report Bug with no Thread, for Settings; loaded when it first opens. */
const AppBugReportDialog = lazy(() =>
  import("./features/threads/bug-reports/bug-report-dialog.js").then(
    (module) => ({ default: module.BugReportDialog }),
  ),
);

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

/** Records the browser's zone once per sign-in, where schedules without DTSTART run. */
function RecordTimeZone() {
  useMountEffect(() => {
    void recordBrowserTimeZone();
  });
  return null;
}

/**
 * Toasts rest below the title bar, and on a Thread page below its view row
 * too, where they cover no control: the composer and its Send sit at the
 * bottom, and the bars above hold the controls a notice refers to, such as
 * Wake. `sonner.css` sets both offsets for each layout.
 */
const belowTitleBar = { top: "var(--dx-toast-top)", right: "16px" };
const belowViewRow = { top: "var(--dx-toast-top-thread)", right: "16px" };

/** The app's one Toaster: top right on desktop, top center on phones. */
function AppToaster({ router }: { readonly router: AppRouter }) {
  const mobile = useMobile();
  const threadPage = useRouterState({
    router,
    select: ({ location }) => /^\/threads\/[^/]+\/?$/u.test(location.pathname),
  });
  const offset = threadPage ? belowViewRow : belowTitleBar;
  return (
    <Toaster
      position={mobile ? "top-center" : "top-right"}
      offset={offset}
      mobileOffset={offset}
      closeButton
    />
  );
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
        <ReportBugSlot.Provider value={AppBugReportDialog}>
          <RouterProvider router={router} />
        </ReportBugSlot.Provider>
        <InAppNavigation key={auth.identity.id} router={router} />
        <RecordTimeZone key={auth.identity.id} />
        <FeedbackWidgetOnDx key={auth.identity.id} />
        <AppToaster router={router} />
        {ReactQueryDevtools === undefined ? null : (
          <Suspense fallback={null}>
            <ReactQueryDevtools />
          </Suspense>
        )}
      </RealtimeProvider>
    </ThreadSessionProvider>
  );
}
