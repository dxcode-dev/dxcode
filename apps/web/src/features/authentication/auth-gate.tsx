import { UserId } from "@dx/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Schema } from "effect";
import * as React from "react";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { Button } from "../../shared/ui/button.js";
import { createPublicRouter } from "./public-router.js";
import { useSignOut } from "./sign-in-mutations.js";
import {
  sessionQueryOptions,
  signInOptionsQueryOptions,
} from "./sign-in-queries.js";
import "./sign-in.css";

const DxLoading = React.lazy(() =>
  import("../../shared/brand/dx-loading.js").then((module) => ({
    default: module.DxLoading,
  })),
);

function SignInUnavailable({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <main className="sign-in-page">
      <div className="sign-in-column">
        <section className="sign-in-card sign-in-status" role="alert">
          <p>{message}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </section>
      </div>
    </main>
  );
}

function SignedOut() {
  const queryClient = useQueryClient();
  const options = useQuery(signInOptionsQueryOptions);
  const router = createPublicRouter(queryClient);
  if (options.isPending)
    return (
      <React.Suspense fallback={null}>
        <DxLoading label="Loading dx…" variant="screen" />
      </React.Suspense>
    );
  if (options.isError)
    return (
      <SignInUnavailable
        message="Sign-in isn't available right now. Check your connection and try again."
        onRetry={() => void options.refetch()}
      />
    );
  return <RouterProvider router={router} />;
}

/**
 * Shows the signed-out router until a session exists, then provides identity
 * to the product. A background session refetch never unmounts either side.
 */
export function AuthGate({
  children,
  onBeforeSignOut,
}: {
  readonly children: React.ReactNode;
  readonly onBeforeSignOut?: (userId: UserId) => void;
}) {
  const session = useQuery(sessionQueryOptions);
  // Keyed on primitives: Better Auth revives the user's timestamps as Dates,
  // which structural sharing cannot reuse, so every focus refetch returns a
  // new user object even when nobody changed.
  const user = session.data?.user;
  const userId = user?.id;
  const name = user?.name ?? "";
  const email = user?.email ?? "";
  const identity =
    userId === undefined
      ? undefined
      : { id: Schema.decodeUnknownSync(UserId)(userId), name, email };
  const signOut = useSignOut(() => {
    if (identity !== undefined) onBeforeSignOut?.(identity.id);
  });
  const logout = signOut.mutate;
  const context =
    identity === undefined ? undefined : { identity, logout: () => logout() };

  if (session.isPending)
    return (
      <React.Suspense fallback={null}>
        <DxLoading label="Loading dx…" variant="screen" />
      </React.Suspense>
    );
  if (session.isError && session.data === undefined)
    return (
      <SignInUnavailable
        message="We couldn't reach dx. Check your connection and try again."
        onRetry={() => void session.refetch()}
      />
    );
  if (context === undefined) return <SignedOut />;
  return (
    <AuthContext.Provider value={context}>{children}</AuthContext.Provider>
  );
}
