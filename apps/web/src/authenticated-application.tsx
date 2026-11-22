import type { QueryClient } from "@tanstack/react-query";
import { RouterProvider, useRouterState } from "@tanstack/react-router";
import { Suspense, use } from "react";
import { attachInAppNavigation } from "./features/install-app/in-app-navigation.js";
import { FeedbackWidgetOnDx } from "./features/projects/feedback-widget-on-dx.js";
import { recordBrowserTimeZone } from "./features/threads/automations/automations-queries.js";
import { RealtimeProvider } from "./features/threads/realtime/realtime-provider.js";
import { ThreadSessionProvider } from "./features/threads/thread-session-provider.js";
import { type AppRouter, createAppRouter } from "./router.js";
import { useIdentity } from "./shared/auth/auth-context.js";
import { keptRouter, routerLoaded } from "./shared/boot/boot-wait.js";
import { ReportBugSlot } from "./shared/bug-reports/report-bug-slot.js";
import { useMountEffect } from "./shared/hooks/use-mount-effect.js";
import {
  HuddleSlot,
  type HuddleSlotProps,
} from "./shared/huddle/huddle-slot.js";
import { artifactLinkHere } from "./shared/navigation/open-artifact.js";
import { lazyComponent } from "./shared/stale-chunk.js";
import { Toaster } from "./shared/ui/sonner.js";
import { toastOffsets } from "./shared/ui/toast-offsets.js";
import { useMobile } from "./shared/use-mobile.js";

const ReactQueryDevtools = import.meta.env.DEV
  ? lazyComponent(() =>
      import("@tanstack/react-query-devtools").then((module) => ({
        default: module.ReactQueryDevtools,
      })),
    )
  : undefined;

/** Report Bug with no Thread, for Settings; loaded when it first opens. */
const AppBugReportDialog = lazyComponent(() =>
  import("./features/threads/bug-reports/bug-report-dialog.js").then(
    (module) => ({ default: module.BugReportDialog }),
  ),
);

/**
 * Lends the router to notification clicks, app launches, and dx links in the
 * installed app, so each changes route in place instead of reloading dx.
 */
function InAppNavigation({ router }: { readonly router: AppRouter }) {
  // A notification that opened dx lands through the Thread route's
  // `beforeLoad`, which shows its artifact where this screen shows them.
  useMountEffect(() =>
    attachInAppNavigation((url) => {
      // Paths the router has no page for, such as `/v1/…`, load as documents.
      if (router.getMatchedRoutes(url.pathname)[2] === undefined) return false;
      const target = artifactLinkHere(url);
      void router.navigate({
        href: target.pathname + target.search + target.hash,
      });
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

/** The app's one Toaster: top right on desktop, top center on phones. */
function AppToaster({ router }: { readonly router: AppRouter }) {
  const mobile = useMobile();
  const threadPage = useRouterState({
    router,
    select: ({ location }) => /^\/threads\/[^/]+\/?$/u.test(location.pathname),
  });
  // Below the bars, where they cover no control: the composer and its Send
  // sit at the bottom, and the bars above hold the controls a notice
  // refers to, such as Wake.
  const offset = threadPage ? toastOffsets.thread : toastOffsets.page;
  return (
    <Toaster
      position={mobile ? "top-center" : "top-right"}
      offset={offset}
      mobileOffset={offset}
      closeButton
    />
  );
}

// Huddle is experimental: none of it ships on first load.
const HuddleButtonEntry = lazyComponent(() =>
  import("./features/huddle/huddle-entry.js").then((module) => ({
    default: module.HuddleButtonEntry,
  })),
);
const HuddleLayerEntry = lazyComponent(() =>
  import("./features/huddle/huddle-entry.js").then((module) => ({
    default: module.HuddleLayerEntry,
  })),
);

function HuddleButtonSlot(props: HuddleSlotProps) {
  return (
    <Suspense fallback={props.fallback ?? null}>
      <HuddleButtonEntry {...props} />
    </Suspense>
  );
}

/**
 * The router once its first page has loaded, so its first frame is that page
 * and not an empty frame while the page's data and code arrive; until then
 * the boot screen shows.
 */
function LoadedRouter({ router }: { readonly router: AppRouter }) {
  use(routerLoaded(router));
  return <RouterProvider router={router} />;
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
  const userId = auth.identity.id;
  const router = keptRouter(queryClient, `app:${userId}`, () =>
    createAppRouter({ queryClient, userId }),
  );
  return (
    <ThreadSessionProvider
      key={auth.identity.id}
      userId={auth.identity.id}
      queryClient={queryClient}
    >
      <RealtimeProvider queryClient={queryClient} userId={auth.identity.id}>
        <ReportBugSlot.Provider value={AppBugReportDialog}>
          <HuddleSlot.Provider value={HuddleButtonSlot}>
            <LoadedRouter router={router} />
          </HuddleSlot.Provider>
        </ReportBugSlot.Provider>
        <InAppNavigation key={auth.identity.id} router={router} />
        <RecordTimeZone key={auth.identity.id} />
        <FeedbackWidgetOnDx key={auth.identity.id} />
        <Suspense fallback={null}>
          <HuddleLayerEntry
            key={`huddle-${auth.identity.id}`}
            onOpenPlace={(place) =>
              void router.navigate({
                to: "/threads/$threadId",
                params: { threadId: place.threadId },
              })
            }
          />
        </Suspense>
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
