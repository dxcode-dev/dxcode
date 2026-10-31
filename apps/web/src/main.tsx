import { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { lazy, Suspense } from "react";
import { AuthGate } from "./features/authentication/auth-gate.js";
import { sessionQueryOptions } from "./features/authentication/sign-in-queries.js";
import { AccountThemeProvider } from "./features/settings/account/account-theme-provider.js";
import { onSessionEnded } from "./shared/auth/session-ended.js";
import { installClientDiagnostics } from "./shared/diagnostics/client-diagnostics.js";
import { queryClient } from "./shared/query/query-client.js";
import "./styles.css";

// Before anything renders, so a bug report holds the earliest failures.
installClientDiagnostics();

const AuthenticatedApplication = lazy(() =>
  import("./authenticated-application.js").then((module) => ({
    default: module.AuthenticatedApplication,
  })),
);

const clearDraftsBeforeSignOut = (userId: UserId) => {
  queryClient.clear();
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
  queryClient.setQueryData(sessionQueryOptions.queryKey, null);
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth",
  });
  void import("./features/threads/new-thread-draft-store.js").then((drafts) => {
    drafts.clearNewThreadDraftsForUser(
      Schema.decodeUnknownSync(UserId)(userId),
    );
  });
});

/** Composes the shared providers and session gate for the dx web client. */
export function Application() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate onBeforeSignOut={clearDraftsBeforeSignOut}>
        <Suspense fallback={null}>
          <AccountThemeProvider>
            <AuthenticatedApplication queryClient={queryClient} />
          </AccountThemeProvider>
        </Suspense>
      </AuthGate>
    </QueryClientProvider>
  );
}
