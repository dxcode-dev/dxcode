import { UserId } from "@dx/domain";
import { hashKey, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { Suspense } from "react";
import { AuthGate } from "./features/authentication/auth-gate.js";
import { sessionQueryOptions } from "./features/authentication/sign-in-queries.js";
import { loadSignedOut } from "./features/authentication/signed-out-loader.js";
import {
  forgetShellPrefetch,
  startShellPrefetch,
} from "./features/navigation/shell-queries.js";
import { AccountThemeProvider } from "./features/settings/account/account-theme-provider.js";
import { peekBootSessionRead } from "./shared/auth/boot-session.js";
import { onSessionEnded } from "./shared/auth/session-ended.js";
import { BootScreen } from "./shared/boot/boot-screen.js";
import { forgetRouters } from "./shared/boot/boot-wait.js";
import {
  clearClientDiagnostics,
  installClientDiagnostics,
} from "./shared/diagnostics/client-diagnostics.js";
import { queryClient } from "./shared/query/query-client.js";
import { lazyComponent } from "./shared/stale-chunk.js";
import { FallbackTitle } from "./shared/ui/document-title.js";
import "./styles.css";

// Before anything renders, so a bug report holds the earliest failures.
installClientDiagnostics();
// index.html's title is the landing title crawlers read; from here React
// renders every title, and FallbackTitle shows "dx" where no page names one.
document.head.querySelector(":scope > title")?.remove();

// A signed-out visitor's pages load lazily: start their download the moment
// the boot's session check finds nobody signed in (before the session query
// below takes that answer), so it overlaps the app's evaluation.
void peekBootSessionRead().then((session) => {
  if (session === null) void loadSignedOut();
});

// The session query starts at boot, taking the check bootstrap sent, and
// AuthGate's query joins it. The shell's data starts the moment that query
// first finds someone signed in (#1379), so a signed-out visitor sends no
// authenticated read (#1599). The signed-in app's code loads beside both.
void queryClient.prefetchQuery(sessionQueryOptions);
const sessionQueryHash = hashKey(sessionQueryOptions.queryKey);
const stopWaitingForSession = queryClient
  .getQueryCache()
  .subscribe(({ query }) => {
    if (query.queryHash !== sessionQueryHash || !query.state.data) return;
    stopWaitingForSession();
    startShellPrefetch();
  });
const authenticatedApplicationModule = import("./authenticated-application.js");
const AuthenticatedApplication = lazyComponent(() =>
  authenticatedApplicationModule.then((module) => ({
    default: module.AuthenticatedApplication,
  })),
);

// A Thread draft's pending write must not reach the next account's session.
// The module is already loaded whenever one is pending, so this runs first.
const discardUnsavedThreadDrafts = () =>
  void import("./features/threads/thread-draft-queries.js").then((drafts) =>
    drafts.discardUnsavedThreadDrafts(),
  );

// A huddle runs outside React and outlives the session: end it so the mic
// stops and the next account in this tab doesn't inherit the call.
const endHuddle = () =>
  void import("./features/huddle/huddle-session.js").then((huddle) =>
    huddle.endHuddleOnSignOut(),
  );

const clearDraftsBeforeSignOut = (userId: UserId) => {
  endHuddle();
  forgetRouters();
  forgetShellPrefetch();
  queryClient.clear();
  clearClientDiagnostics();
  discardUnsavedThreadDrafts();
  void import("./features/threads/new-thread-draft-store.js").then((drafts) => {
    drafts.clearNewThreadDraftsForUser(userId);
  });
};

// Core closed a socket or refused a request because this browser's session
// ended: sign out here as the sign-out button does, which shows sign-in. A
// signed-out page (a public Thread) keeps its data. The session is set first:
// clearing the cache would detach the session query AuthGate observes.
onSessionEnded(() => {
  const userId = queryClient.getQueryData(sessionQueryOptions.queryKey)?.user
    .id;
  if (userId === undefined) return;
  endHuddle();
  forgetRouters();
  forgetShellPrefetch();
  queryClient.setQueryData(sessionQueryOptions.queryKey, null);
  clearClientDiagnostics();
  discardUnsavedThreadDrafts();
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth",
  });
  void import("./features/threads/new-thread-draft-store.js").then((drafts) => {
    drafts.clearNewThreadDraftsForUser(
      Schema.decodeUnknownSync(UserId)(userId),
    );
  });
});

/**
 * Composes the shared providers and session gate for the dx web client.
 * Everything the first page waits for (the session, the account's theme, the
 * signed-out or signed-in code, the router's first load) suspends into one
 * boundary, so a launch shows one loading screen and then the right page.
 */
export function Application() {
  return (
    <QueryClientProvider client={queryClient}>
      <FallbackTitle />
      <Suspense fallback={<BootScreen />}>
        <AuthGate onBeforeSignOut={clearDraftsBeforeSignOut}>
          <AccountThemeProvider>
            <AuthenticatedApplication queryClient={queryClient} />
          </AccountThemeProvider>
        </AuthGate>
      </Suspense>
    </QueryClientProvider>
  );
}
