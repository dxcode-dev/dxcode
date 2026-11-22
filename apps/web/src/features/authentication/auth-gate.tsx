import { UserId } from "@dx/domain";
import { lazyRouteComponent } from "@tanstack/react-router";
import { Schema } from "effect";
import type * as React from "react";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { useBootQuery } from "../../shared/boot/boot-wait.js";
import { sessionQueryOptions } from "./sign-in-queries.js";
import { SignInUnavailable } from "./sign-in-unavailable.js";
import { useSignOut } from "./sign-out-mutation.js";
import { loadSignedOut } from "./signed-out-loader.js";

// Signing out of a tab opened before a deploy asks for a chunk the deploy
// replaced. TanStack's lazy route component, which the router's pages use,
// reloads once to pick up the new build and keeps the loading screen
// meanwhile instead of unmounting the app.
const SignedOut = lazyRouteComponent(loadSignedOut, "SignedOut");

/**
 * Shows the signed-out router until a session exists, then provides identity
 * to the product. A background session refetch never unmounts either side.
 * Until the first session check answers it suspends, so the boot screen
 * above it shows and nothing else does.
 */
export function AuthGate({
  children,
  onBeforeSignOut,
}: {
  readonly children: React.ReactNode;
  readonly onBeforeSignOut?: (userId: UserId) => void;
}) {
  const session = useBootQuery(sessionQueryOptions);
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
