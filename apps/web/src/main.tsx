import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { AuthGate } from "./features/authentication/auth-gate.js";
import { AccountThemeProvider } from "./features/settings/account/account-theme-provider.js";
import { queryClient } from "./shared/query/query-client.js";
import "./styles.css";

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
